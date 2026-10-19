import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { z } from 'zod';
import { parseUserScript } from '../desktop/bun/ocs-assets';
import { createGmStorage } from '../desktop/bun/ocs-gm-storage';
import { attachUserScripts, type UserScriptController } from '../desktop/ocs/userscripts';
import { gmGrants } from '../desktop/ocs/gm-types';

function script(name: string, runAt: string, grants: readonly string[], body: string): string {
  return ['// ==UserScript==', '// @name ' + name, '// @version 1', '// @match http://127.0.0.1/*', '// @run-at ' + runAt, ...grants.map(grant => '// @grant ' + grant), '// ==/UserScript==', body].join('\n');
}
const contextSchema = z.object({ context: z.object({ id: z.number().int(), name: z.string() }) });
async function inspector(page: Page): Promise<{ session: CDPSession; worlds: Map<number, string> }> {
  const session = await page.context().newCDPSession(page);
  const worlds = new Map<number, string>();
  session.on('Runtime.executionContextCreated', (raw: unknown) => { const value = contextSchema.parse(raw).context; worlds.set(value.id, value.name); });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  session.on('Runtime.executionContextDestroyed', (raw: unknown) => { worlds.delete(z.object({ executionContextId: z.number().int() }).parse(raw).executionContextId); });
  await session.send('Runtime.enable');
  return { session, worlds };
}
async function evaluate(session: CDPSession, contextId: number, expression: string): Promise<unknown> {
  const reply = await session.send('Runtime.evaluate', { contextId, expression, awaitPromise: true, returnByValue: true });
  if (reply.exceptionDetails) throw new Error('The authored isolated-world test expression failed: ' + reply.exceptionDetails.text);
  const result: unknown = reply.result.value;
  return result;
}
async function world(inspect: Awaited<ReturnType<typeof inspector>>, name: string): Promise<number> {
  for (const [id, label] of inspect.worlds) {
    if (!label.startsWith('swu-gm-')) continue;
    const actual = await evaluate(inspect.session, id, "typeof GM_info === 'object' ? GM_info.script.name : null");
    if (actual === name) return id;
  }
  throw new Error('The real isolated script world was not found: ' + name);
}

const realTest = process.env['SWU_OCS_GM_INVESTIGATION'] === '1' ? test : test.skip;
realTest('GM storage subset uses real isolated CDP identities and encrypted profile/script/digest stores', async () => {
  const root = process.env['SWU_OCS_GM_DIRECTORY'];
  const temp = process.env['TEMP'];
  const executablePath = process.env['SWU_OCS_BROWSER'];
  if (!root || !temp || !executablePath || !isAbsolute(root)) throw new Error('Explicit isolated GM directory, TEMP and Chrome path are required.');
  const distance = relative(resolve(temp), resolve(root));
  if (!distance || isAbsolute(distance) || distance.startsWith('..' + sep) || distance === '..' || !distance.split(sep)[0]?.startsWith('swu-ocs-gm-')) throw new Error('The GM investigation must stay in its isolated TEMP prefix.');
  await mkdir(root, { recursive: true });
  const profileId = randomUUID();
  const primary = parseUserScript(randomUUID(), script('Storage A', 'document-end', gmGrants, 'globalThis.__gmPhase=document.readyState;'));
  const sibling = parseUserScript(randomUUID(), script('Storage B', 'document-end', gmGrants, 'globalThis.__gmPhase=document.readyState;'));
  const start = parseUserScript(randomUUID(), script('Start', 'document-start', ['GM_info', 'GM_getValue'], "globalThis.__gmPhase=document.readyState;globalThis.__gmStartValue=GM_getValue('start',null);"));
  const idle = parseUserScript(randomUUID(), script('Idle', 'document-idle', ['GM_info'], 'globalThis.__gmPhase=document.readyState;'));
  const none = parseUserScript(randomUUID(), script('None', 'document-end', ['none'], 'document.documentElement.dataset.none="yes";'));
  const programs = [primary, sibling, start, idle, none];
  const store = createGmStorage(root, profileId, primary.id, primary.digest);
  const privateValue = 'authored-test-' + randomUUID();
  await store.save({ seed: privateValue });
  await createGmStorage(root, profileId, start.id, start.digest).save({ start: 8 });
  expect(await store.read()).toEqual({ seed: privateValue });
  expect(await createGmStorage(root, randomUUID(), primary.id, primary.digest).read()).toEqual({});
  expect(await createGmStorage(root, profileId, sibling.id, primary.digest).read()).toEqual({});
  const changed = parseUserScript(primary.id, primary.content + '\nvoid 0;');
  expect(changed.digest).not.toBe(primary.digest);
  expect(await createGmStorage(root, profileId, primary.id, changed.digest).read()).toEqual({});
  for (const grant of ['GM_xmlhttpRequest', 'unsafeWindow', 'GM_unknown']) {
    expect(parseUserScript(randomUUID(), script('Unsupported', 'document-end', [grant], '')).supported).toBe(false);
  }
  for (const directive of ['// @require https://example.invalid/source.js', '// @resource name https://example.invalid/data', '// @connect *']) {
    expect(parseUserScript(randomUUID(), script('Unsupported', 'document-end', ['GM_getValue'], '').replace('// ==/UserScript==', directive + '\n// ==/UserScript==')).supported).toBe(false);
  }
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    const frame = new URL(request.url).pathname === '/frame';
    return new Response('<!doctype html><html><body><div id="test-root"></div>' + (frame ? '' : '<iframe id="test-frame" src="/frame"></iframe>') + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
  } });
  const reports: { id: string; outcome: string }[] = [];
  const context = await chromium.launchPersistentContext(join(root, 'chrome-profile'), { executablePath, headless: false, viewport: { width: 900, height: 700 }, args: ['--no-first-run', '--disable-background-networking'] });
  let controller: UserScriptController | null = null;
  let failure: unknown = null;
  try {
    await expect(attachUserScripts(context, [primary], () => {}, null)).rejects.toThrow('Explicit GM storage root');
    await expect(attachUserScripts(context, [{ ...primary, content: primary.content + '\nvoid 1;' }], () => {}, { root, profileId })).rejects.toThrow('source digest changed');
    controller = await attachUserScripts(context, programs, (id, outcome) => { reports.push({ id, outcome }); }, { root, profileId });
    const page = context.pages()[0];
    if (!page) throw new Error('The persistent context did not contain its initial page.');
    const inspect = await inspector(page);
    await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: 'load' });
    await controller.flush();
    const a = await world(inspect, 'Storage A');
    const b = await world(inspect, 'Storage B');
    expect(a).not.toBe(b);
    expect(await evaluate(inspect.session, a, "GM_getValue('seed',null)")).toBe(privateValue);
    expect(await evaluate(inspect.session, b, "GM_getValue('seed',null)")).toBe(null);
    expect(await evaluate(inspect.session, a, 'globalThis.__gmPhase')).toBe('interactive');
    expect(await evaluate(inspect.session, await world(inspect, 'Start'), 'globalThis.__gmPhase')).toBe('loading');
    expect(await evaluate(inspect.session, await world(inspect, 'Start'), 'globalThis.__gmStartValue')).toBe(8);
    expect(await evaluate(inspect.session, await world(inspect, 'Idle'), 'globalThis.__gmPhase')).toBe('complete');
    expect(await page.locator('html').getAttribute('data-none')).toBe('yes');
    expect(await page.evaluate(() => ['GM_info', 'GM_getValue', 'GM_setValue', 'GM_deleteValue', 'GM_listValues'].every(name => typeof Reflect.get(globalThis, name) === 'undefined'))).toBe(true);
    const channels = z.array(z.string()).parse(await evaluate(inspect.session, a, "Object.getOwnPropertyNames(globalThis).filter(name=>name.startsWith('__swu_gm_')&&!name.endsWith('_client'))"));
    expect(channels).toHaveLength(1);
    expect(await page.evaluate(names => names.every(name => typeof Reflect.get(globalThis, name) === 'undefined'), channels)).toBe(true);
    const beforeForgery = reports.filter(item => item.id === primary.id).length;
    await page.evaluate(async id => { const binding: unknown = Reflect.get(globalThis, '__swuOcsScriptOutcome'); if (typeof binding !== 'function') throw new Error('The grant-none outcome binding is absent.'); await binding(id, 'executed'); }, primary.id);
    expect(reports.filter(item => item.id === primary.id)).toHaveLength(beforeForgery);
    await evaluate(inspect.session, a, "GM_setValue('count',{n:1}).then(()=>true)");
    expect((await store.read())['count']).toEqual({ n: 1 });
    expect(await evaluate(inspect.session, a, "GM_getValue('count',null)")).toEqual({ n: 1 });
    const frameContexts: number[] = [];
    for (const [id, name] of inspect.worlds) {
      if (name.startsWith('swu-gm-') && await evaluate(inspect.session, id, "typeof GM_info==='object'&&GM_info.script.name==='Storage A'")) frameContexts.push(id);
    }
    expect(frameContexts.length).toBeGreaterThanOrEqual(2);
    for (const id of frameContexts) expect(await evaluate(inspect.session, id, "GM_getValue('count',null)")).toEqual({ n: 1 });
    const second = await context.newPage();
    await controller.flush();
    const secondInspect = await inspector(second);
    await second.goto(`http://127.0.0.1:${server.port}/frame`, { waitUntil: 'load' });
    const secondA = await world(secondInspect, 'Storage A');
    expect(await evaluate(secondInspect.session, secondA, "GM_getValue('count',null)")).toEqual({ n: 1 });
    await evaluate(secondInspect.session, secondA, "GM_setValue('count',2).then(()=>true)");
    expect(await evaluate(inspect.session, a, "GM_getValue('count',null)")).toBe(2);
    expect(await evaluate(secondInspect.session, secondA, 'GM_listValues().sort()')).toEqual(['count', 'seed']);
    await evaluate(secondInspect.session, secondA, "GM_deleteValue('count').then(()=>true)");
    expect(await evaluate(inspect.session, a, "GM_getValue('count','missing')")).toBe('missing');
    expect(await evaluate(inspect.session, a, "(()=>{try{GM_setValue('bad',{n:NaN});return false;}catch{return true;}})()")).toBe(true);
    expect(await evaluate(inspect.session, await world(inspect, 'Start'), "typeof GM_setValue")).toBe('undefined');
    await evaluate(inspect.session, a, "GM_setValue('navigation',3).then(()=>true)");
    await page.reload({ waitUntil: 'load' });
    await controller.flush();
    const navigationWorld = await world(inspect, 'Storage A');
    expect(await evaluate(inspect.session, navigationWorld, "GM_getValue('seed',null)")).toBe(privateValue);
    expect(await evaluate(inspect.session, navigationWorld, "GM_getValue('navigation',null)")).toBe(3);
    await evaluate(inspect.session, navigationWorld, "GM_deleteValue('navigation').then(()=>true)");
    await second.close();
    await controller.flush();
    expect(controller.isSettled()).toBe(false);
    await evaluate(inspect.session, navigationWorld, "globalThis.__closingResults=[];for(let i=0;i<8;i++)GM_setValue('closing-'+i,i).then(()=>__closingResults.push('committed'),error=>__closingResults.push(error.name));true");
    const closingStarted = performance.now();
    const disposal = controller.dispose();
    expect(controller.dispose()).toBe(disposal);
    expect(controller.isSettled()).toBe(false);
    // Observe pending promises before waiting for the host's DPAPI/drain work.
    const pendingState = z.array(z.string()).parse(await evaluate(inspect.session, navigationWorld, 'globalThis.__closingResults'));
    expect(pendingState).toHaveLength(8);
    expect(pendingState.at(-1)).toBe('AbortError');
    expect(await evaluate(inspect.session, navigationWorld, "GM_setValue('after-dispose',1).then(()=>false,error=>error.name==='AbortError')")).toBe(true);
    await disposal;
    expect(performance.now() - closingStarted).toBeLessThan(20_000);
    expect(controller.isSettled()).toBe(true);
    const closedValues = await store.read();
    expect(closedValues['closing-7']).toBeUndefined();
    expect(closedValues['after-dispose']).toBeUndefined();
    controller = null;
    const encryptedDirectory = join(root, 'gm-values', profileId, primary.id);
    const names = await readdir(encryptedDirectory);
    for (const name of names) expect((await readFile(join(encryptedDirectory, name), 'utf8')).includes(privateValue)).toBe(false);
    expect(await store.read()).toEqual(closedValues);
    expect(reports.some(item => item.outcome === 'failed')).toBe(false);
    const rejected = parseUserScript(randomUUID(), script('Rejected write', 'document-end', gmGrants, ''));
    const rejectedStore = createGmStorage(root, profileId, rejected.id, rejected.digest);
    await rejectedStore.read();
    await mkdir(join(root, 'gm-values', profileId, rejected.id, rejected.digest + '.dpapi.json.pending'));
    const browser = context.browser();
    if (!browser) throw new Error('The real persistent browser is unavailable.');
    const rejectedContext = await browser.newContext();
    const rejectedPage = await rejectedContext.newPage();
    const readOnly = parseUserScript(randomUUID(), script('Read only', 'document-end', ['GM_info', 'GM_getValue'], ''));
    controller = await attachUserScripts(rejectedContext, [rejected, readOnly], (id, outcome) => { reports.push({ id, outcome }); }, { root, profileId });
    const rejectedInspector = await inspector(rejectedPage);
    await rejectedPage.goto(`http://127.0.0.1:${server.port}/frame`, { waitUntil: 'load' });
    const rejectedWorld = await world(rejectedInspector, 'Rejected write');
    expect(await evaluate(rejectedInspector.session, rejectedWorld, "GM_setValue('denied',1).then(()=>false,()=>true)")).toBe(true);
    expect(await rejectedStore.read()).toEqual({});
    await expect(controller.flush()).rejects.toThrow('outstanding failures');
    const readOnlyWorld = await world(rejectedInspector, 'Read only');
    expect(await evaluate(rejectedInspector.session, readOnlyWorld, "typeof GM_setValue")).toBe('undefined');
    await evaluate(rejectedInspector.session, readOnlyWorld, "(()=>{const channel=Object.getOwnPropertyNames(globalThis).find(name=>name.startsWith('__swu_gm_')&&!name.endsWith('_client'));globalThis[channel](JSON.stringify({method:'set',requestId:1,key:'forged',value:1}));return true;})()");
    for (let attempt = 0; attempt < 100 && !reports.some(item => item.id === readOnly.id && item.outcome === 'failed'); attempt += 1) await Bun.sleep(10);
    expect(reports.some(item => item.id === readOnly.id && item.outcome === 'failed')).toBe(true);
    expect(await createGmStorage(root, profileId, readOnly.id, readOnly.digest).read()).toEqual({});
    await expect(controller.dispose()).rejects.toThrow('outstanding failures');
    await expect(controller.flush()).rejects.toThrow('outstanding failures');
    expect(controller.isSettled()).toBe(true);
    controller = null;
    await rejectedContext.close();
    const plainContext = await browser.newContext();
    controller = await attachUserScripts(plainContext, [none], () => {}, null);
    expect(controller.isSettled()).toBe(false);
    await controller.flush();
    const plainDisposal = controller.dispose();
    expect(controller.dispose()).toBe(plainDisposal);
    await plainDisposal;
    expect(controller.isSettled()).toBe(true);
    controller = null;
    await plainContext.close();
    await writeFile(join(root, 'summary.json'), JSON.stringify({ ok: true, supported: gmGrants, unsupported: ['GM_xmlhttpRequest', 'unsafeWindow', 'GM_unknown'], runAt: ['document-start', 'document-end', 'document-idle'], mainWorldHasBindings: false, frameWorlds: frameContexts.length, reports: reports.length, actualDpapi: true, compiledRuntimeTested: false }, null, 2), 'utf8');
  } catch (cause) { failure = cause; }
  finally {
    const errors: unknown[] = failure === null ? [] : [failure];
    if (controller) { try { await controller.dispose(); } catch (cause) { errors.push(cause); } }
    try { await context.close(); } catch (cause) { errors.push(cause); }
    server.stop(true);
    if (errors.length) throw new AggregateError(errors, 'The real isolated GM investigation or its normal cleanup failed.');
  }
}, 180_000);
