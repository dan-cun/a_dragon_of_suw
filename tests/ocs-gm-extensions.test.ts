import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { z } from 'zod';
import { parseUserScript, type ScriptProgram } from '../desktop/bun/ocs-assets';
import { createGmStorage } from '../desktop/bun/ocs-gm-storage';
import { attachUserScripts } from '../desktop/ocs/userscripts';
import { gmGrants } from '../desktop/ocs/gm-types';

const integration = process.env['SWU_OCS_RUNTIME_GM_TEST'] === '1' ? test : test.skip;
const work = await mkdtemp(join(resolve(import.meta.dir, '../work'), 'ocs-gm-extensions-'));
const results: { name: string; passed: boolean }[] = [];
const sources = ['desktop/ocs/gm-types.ts', 'desktop/ocs/gm-world.ts', 'desktop/ocs/gm-runtime.ts', 'desktop/bun/ocs-assets.ts', 'tests/ocs-gm-extensions.test.ts'];
const fingerprints = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(resolve(import.meta.dir, '..', path))).digest('hex')] as const)));
if (process.env['SWU_OCS_RUNTIME_GM_TEST'] === '1') console.log(JSON.stringify({ event: 'ocs.gm.extensions.evidence', work }));
function script(name: string, grants: readonly string[]): ScriptProgram {
  return parseUserScript(randomUUID(), ['// ==UserScript==', '// @name ' + name, '// @version 1', '// @match http://127.0.0.1/*', '// @run-at document-end', ...grants.map(grant => '// @grant ' + grant), '// ==/UserScript==', 'globalThis.__events=[];'].join('\n'));
}
const nativeWorldSchema = z.object({ id: z.number().int(), uniqueId: z.string(), name: z.string() });
type NativeWorld = z.infer<typeof nativeWorldSchema>;
async function inspector(page: Page) {
  const session = await page.context().newCDPSession(page);
  const worlds = new Map<number, NativeWorld>();
  session.on('Runtime.executionContextCreated', (raw: unknown) => { const event = z.object({ context: nativeWorldSchema }).parse(raw); worlds.set(event.context.id, event.context); });
  session.on('Runtime.executionContextDestroyed', (raw: unknown) => { worlds.delete(z.object({ executionContextId: z.number().int() }).parse(raw).executionContextId); });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  await session.send('Runtime.enable');
  return { session, worlds };
}
async function evaluate(session: CDPSession, world: NativeWorld, expression: string): Promise<unknown> {
  const reply = await session.send('Runtime.evaluate', { uniqueContextId: world.uniqueId, expression, returnByValue: true, awaitPromise: true, timeout: 10000 });
  if (reply.exceptionDetails) throw new Error('The authored GM extension expression failed: ' + (reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text));
  const value: unknown = reply.result.value;
  return value;
}
async function world(inspect: Awaited<ReturnType<typeof inspector>>, name: string, pathname: string): Promise<NativeWorld> {
  for (const candidate of inspect.worlds.values()) {
    if (!candidate.name.startsWith('swu-gm-')) continue;
    if (await evaluate(inspect.session, candidate, `typeof GM_info==='object'&&GM_info.script.name===${JSON.stringify(name)}&&location.pathname===${JSON.stringify(pathname)}`)) return candidate;
  }
  throw new Error('The exact authored script world is missing: ' + name + ' ' + pathname);
}
async function fixture(name: string, programs: ScriptProgram[]) {
  const executablePath = process.env['SWU_OCS_BROWSER'];
  if (!executablePath || !isAbsolute(executablePath) || Object.hasOwn(process.env, 'SWU_OCS_DIST')) throw new Error('Explicit SWU_OCS_BROWSER and truly absent SWU_OCS_DIST are required.');
  const root = join(work, name);
  await mkdir(root);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    return new Response('<!doctype html><html><head></head><body><div id="styled">Local authored GM integration</div>' + (new URL(request.url).pathname === '/framed' ? '<iframe id="owned-frame" src="/frame"></iframe>' : '') + '</body></html>', { headers: { 'Content-Type': 'text/html' } });
  } });
  const context = await chromium.launchPersistentContext(join(root, 'chrome'), { executablePath, headless: true, serviceWorkers: 'block', args: ['--no-first-run', '--disable-background-networking'] });
  const reports: { id: string; outcome: string }[] = [];
  const profileId = randomUUID();
  const controller = await attachUserScripts(context, programs, (id, outcome) => { reports.push({ id, outcome }); }, { root, profileId });
  const page = context.pages()[0];
  if (!page) throw new Error('The real Chrome initial page is missing.');
  const inspect = await inspector(page);
  const origin = `http://127.0.0.1:${server.port}`;
  await page.goto(origin + '/framed', { waitUntil: 'load' });
  await controller.flush();
  return { root, context, page, inspect, origin, server, controller, reports, profileId };
}
async function finish(subject: Awaited<ReturnType<typeof fixture>>, name: string, failure: unknown, expectedRuntimeFailure: boolean): Promise<void> {
  const errors: unknown[] = failure === null ? [] : [failure];
  try {
    if (expectedRuntimeFailure) {
      await expect(subject.controller.dispose()).rejects.toThrow('outstanding failures');
      expect(subject.controller.isSettled()).toBe(true);
    } else await subject.controller.dispose();
  } catch (cause) { errors.push(cause); }
  try { await subject.context.close(); } catch (cause) { errors.push(cause); }
  await subject.server.stop(true);
  results.push({ name, passed: errors.length === 0 });
  await writeFile(join(work, 'result.json'), JSON.stringify({ results, fingerprints, realChrome: true, realDpapi: true, schoolAccounts: false, compiledDesktopTested: false }, null, 2), 'utf8');
  if (errors.length) throw new AggregateError(errors, 'GM extension integration or normal cleanup failed; no browser was force-terminated.');
}

integration('GM extensions: durable value changes clone values, identify remote contexts and permit reentrant writes', async () => {
  const primary = script('Extensions A', gmGrants);
  const sibling = script('Extensions B', ['GM_info', 'GM_getValue', 'GM_addValueChangeListener']);
  const subject = await fixture('value-changes', [primary, sibling]);
  let failure: unknown = null;
  try {
    const a = await world(subject.inspect, primary.name, '/framed');
    const frame = await world(subject.inspect, primary.name, '/frame');
    const b = await world(subject.inspect, sibling.name, '/framed');
    const second = await subject.context.newPage(); await subject.controller.flush();
    const secondInspect = await inspector(second);
    await second.goto(subject.origin + '/second');
    const remote = await world(secondInspect, primary.name, '/second');
    const listener = "globalThis.__listener=GM_addValueChangeListener('value',(key,oldValue,newValue,remote)=>{__events.push({key,oldValue,newValue,remote});if(oldValue&&typeof oldValue==='object')oldValue.n=999;if(newValue&&typeof newValue==='object')newValue.n=999;});true";
    for (const entry of [{ inspect: subject.inspect, world: a }, { inspect: subject.inspect, world: frame }, { inspect: secondInspect, world: remote }, { inspect: subject.inspect, world: b }]) await evaluate(entry.inspect.session, entry.world, listener);
    await evaluate(subject.inspect.session, a, "GM_setValue('value',{n:1}).then(()=>true)");
    const store = createGmStorage(subject.root, subject.profileId, primary.id, primary.digest);
    expect(await store.read()).toEqual({ value: { n: 1 } });
    expect(await evaluate(subject.inspect.session, a, "GM_getValue('value',null)")).toEqual({ n: 1 });
    expect(await evaluate(subject.inspect.session, a, '__events.map(e=>e.remote)')).toEqual([false]);
    expect(await evaluate(subject.inspect.session, frame, '__events.map(e=>e.remote)')).toEqual([true]);
    expect(await evaluate(secondInspect.session, remote, '__events.map(e=>e.remote)')).toEqual([true]);
    expect(await evaluate(subject.inspect.session, b, '__events')).toEqual([]);
    await evaluate(subject.inspect.session, a, "GM_addValueChangeListener('value',(key,oldValue,newValue,remote)=>__events.push({copyOld:oldValue,copyNew:newValue}));true");
    await evaluate(subject.inspect.session, a, "GM_setValue('value',{n:2}).then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, '__events.at(-1)')).toEqual({ copyOld: { n: 1 }, copyNew: { n: 2 } });
    await evaluate(secondInspect.session, remote, 'GM_removeValueChangeListener(__listener);true');
    await evaluate(subject.inspect.session, a, "GM_setValue('value',{n:2}).then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, '__events.length')).toBe(3);
    await evaluate(subject.inspect.session, a, "GM_deleteValue('value').then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, "(()=>{const e=__events.at(-2);return e.oldValue.n===999&&e.newValue===undefined&&!e.remote;})()")).toBe(true);
    expect(await evaluate(secondInspect.session, remote, '__events.length')).toBe(2);
    await evaluate(subject.inspect.session, a, "GM_deleteValue('value').then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, '__events.length')).toBe(5);
    expect(await evaluate(subject.inspect.session, a, "(()=>{const events=[];GM_addValueChangeListener('ordered',(key,oldValue,newValue,remote)=>events.push({key,oldValue,newValue,remote}));globalThis.__ordered=events;return true;})()")).toBe(true);
    await evaluate(subject.inspect.session, a, "GM_setValue('ordered',{a:1,b:[{x:2,y:3}]}).then(()=>GM_setValue('ordered',{b:[{y:3,x:2}],a:1})).then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, '__ordered')).toEqual([{ key: 'ordered', newValue: { a: 1, b: [{ x: 2, y: 3 }] }, remote: false }]);
    await evaluate(subject.inspect.session, a, "GM_deleteValue('ordered').then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, '__ordered.length')).toBe(2);
    await evaluate(subject.inspect.session, a, "GM_addValueChangeListener('trigger',()=>GM_setValue('reentrant',9));true");
    await evaluate(subject.inspect.session, a, "GM_setValue('trigger',1).then(()=>true)");
    await subject.controller.flush();
    expect(await store.read()).toEqual({ trigger: 1, reentrant: 9 });
    const ciphertext = await readFile(join(subject.root, 'gm-values', subject.profileId, primary.id, primary.digest + '.dpapi.json'), 'utf8');
    expect(ciphertext.includes('reentrant')).toBe(false);
    expect(await subject.page.evaluate(names => names.every(name => typeof Reflect.get(globalThis, name) === 'undefined') && !Object.getOwnPropertyNames(globalThis).some(name => name.startsWith('__swu_gm_')), [...gmGrants])).toBe(true);
    expect(await evaluate(subject.inspect.session, b, "typeof GM_addStyle+':'+typeof GM_saveTab")).toBe('undefined:undefined');
    expect(await evaluate(subject.inspect.session, a, "GM_info.capabilities.network===false&&GM_info.capabilities.unsafeWindow===false")).toBe(true);
    expect(subject.reports.some(report => report.outcome === 'failed')).toBe(false);
  } catch (cause) { failure = cause; }
  finally { await finish(subject, 'value-changes', failure, false); }
}, 120000);

integration('GM extensions: tab identity belongs to native Page across frames/navigation, with isolated scope and close cleanup', async () => {
  const primary = script('Tabs A', gmGrants); const sibling = script('Tabs B', gmGrants);
  const subject = await fixture('tabs-and-style', [primary, sibling]);
  let failure: unknown = null;
  try {
    let a = await world(subject.inspect, primary.name, '/framed');
    const frame = await world(subject.inspect, primary.name, '/frame');
    const b = await world(subject.inspect, sibling.name, '/framed');
    const read = "new Promise((resolve,reject)=>GM_getTab(resolve).catch(reject))";
    const all = "new Promise((resolve,reject)=>GM_getTabs(resolve).catch(reject))";
    expect(await evaluate(subject.inspect.session, a, 'GM_getTab()')).toEqual({});
    expect(await evaluate(subject.inspect.session, a, read)).toEqual({});
    await evaluate(subject.inspect.session, a, "GM_saveTab({marker:'first',nested:{n:1}}).then(()=>true)");
    expect(await evaluate(subject.inspect.session, frame, "GM_getTab(value=>{value.nested.n=99;})")).toEqual({ marker: 'first', nested: { n: 1 } });
    expect(await evaluate(subject.inspect.session, frame, read)).toEqual({ marker: 'first', nested: { n: 1 } });
    expect(await evaluate(subject.inspect.session, b, read)).toEqual({});
    await evaluate(subject.inspect.session, frame, "GM_getTab(value=>{value.nested.n=99;}).then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, read)).toEqual({ marker: 'first', nested: { n: 1 } });
    const firstTabs = z.record(z.string(), z.object({ marker: z.literal('first'), nested: z.object({ n: z.literal(1) }) })).parse(await evaluate(subject.inspect.session, a, all));
    const firstId = Object.keys(firstTabs)[0]; expect(firstId).toBeDefined();
    const second = await subject.context.newPage(); await subject.controller.flush();
    const secondInspect = await inspector(second); await second.goto(subject.origin + '/second');
    const remote = await world(secondInspect, primary.name, '/second');
    expect(await evaluate(secondInspect.session, remote, read)).toEqual({});
    await evaluate(secondInspect.session, remote, `(()=>{const channel=Object.getOwnPropertyNames(globalThis).find(n=>/^__swu_gm_[a-f0-9]+$/.test(n));globalThis[channel](JSON.stringify({method:'tab-save',requestId:9876,value:{marker:'second'},tabId:${JSON.stringify(firstId)},profileId:'forged',scriptId:${JSON.stringify(sibling.id)}}));return true;})()`);
    await subject.controller.flush();
    expect(await evaluate(subject.inspect.session, a, read)).toEqual({ marker: 'first', nested: { n: 1 } });
    expect(await evaluate(secondInspect.session, remote, read)).toEqual({ marker: 'second' });
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(await evaluate(subject.inspect.session, a, all)))).toHaveLength(2);
    expect(await evaluate(subject.inspect.session, a, "GM_addStyle('#styled { color: rgb(1, 2, 3); }').tagName")).toBe('STYLE');
    expect(await subject.page.locator('#styled').evaluate(element => getComputedStyle(element).color)).toBe('rgb(1, 2, 3)');
    await subject.page.goto(subject.origin + '/navigated'); await subject.controller.flush();
    a = await world(subject.inspect, primary.name, '/navigated');
    expect(await evaluate(subject.inspect.session, a, read)).toEqual({ marker: 'first', nested: { n: 1 } });
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(await evaluate(subject.inspect.session, a, all)))).toContain(firstId as string);
    await second.close(); await subject.controller.flush();
    expect(await evaluate(subject.inspect.session, a, all)).toEqual(firstTabs);
    const browser = subject.context.browser(); if (!browser) throw new Error('The real Chrome browser is missing.');
    const changed = parseUserScript(primary.id, primary.content + '\nvoid 0;');
    for (const scope of [{ program: primary, profileId: randomUUID() }, { program: changed, profileId: subject.profileId }]) {
      const isolated = await browser.newContext(); const isolatedPage = await isolated.newPage();
      const isolatedController = await attachUserScripts(isolated, [scope.program], () => {}, { root: subject.root, profileId: scope.profileId });
      try {
        const isolatedInspect = await inspector(isolatedPage); await isolatedPage.goto(subject.origin + '/isolated');
        const isolatedWorld = await world(isolatedInspect, scope.program.name, '/isolated');
        expect(await evaluate(isolatedInspect.session, isolatedWorld, read)).toEqual({});
        const tabs = z.record(z.string(), z.unknown()).parse(await evaluate(isolatedInspect.session, isolatedWorld, all));
        expect(Object.values(tabs)).toEqual([{}]); expect(Object.keys(tabs)).not.toContain(firstId as string);
      } finally { try { await isolatedController.dispose(); } finally { await isolated.close(); } }
    }
    expect(await evaluate(subject.inspect.session, a, 'GM_getTabs()')).toEqual(firstTabs);
    expect(await evaluate(subject.inspect.session, a, "GM_getTab(async value=>{await GM_saveTab(value);})")).toEqual({ marker: 'first', nested: { n: 1 } });
    expect(await evaluate(subject.inspect.session, a, "(()=>{globalThis.__savedStyle=GM_addStyle;const before=document.querySelectorAll('style').length;history.pushState(null,'','/spa');try{__savedStyle('body{}');return false;}catch(error){return error.name==='AbortError'&&document.querySelectorAll('style').length===before;}})()")).toBe(true);
    await subject.controller.flush();
    expect(await evaluate(subject.inspect.session, a, "GM_saveTab({late:true}).then(()=>false,error=>error.name==='AbortError')")).toBe(true);
    expect(await evaluate(subject.inspect.session, a, "(()=>{try{GM_addStyle('body{}');return false;}catch(error){return error.name==='AbortError';}})()")).toBe(true);
    await subject.page.goto(subject.origin + '/restored'); await subject.controller.flush();
    a = await world(subject.inspect, primary.name, '/restored');
    expect(await evaluate(subject.inspect.session, a, read)).toEqual({ marker: 'first', nested: { n: 1 } });
    expect(subject.reports.some(report => report.outcome === 'failed')).toBe(false);
    await subject.controller.dispose();
    expect(subject.controller.isSettled()).toBe(true);
    expect(await evaluate(subject.inspect.session, a, "(()=>{try{GM_addStyle('body{}');return false;}catch(error){return error.name==='AbortError';}})()")).toBe(true);
    expect(await evaluate(subject.inspect.session, a, "(()=>{const name=Object.getOwnPropertyNames(globalThis).find(name=>name.startsWith('__swu_gm_')&&name.endsWith('_client'));let invalid=false;try{globalThis[name].revoke(null);}catch(error){invalid=error.name==='TypeError';}try{GM_addStyle('body{}');return false;}catch(error){return invalid&&error.name==='AbortError';}})()")).toBe(true);
  } catch (cause) { failure = cause; }
  finally { await finish(subject, 'tabs-and-style', failure, false); }
}, 120000);

integration('GM extensions: real persistence and callback failures are reported without false successful notifications', async () => {
  const primary = script('Failure A', gmGrants); const blocked = script('Failure B', gmGrants);
  const subject = await fixture('failures', [primary, blocked]);
  let failure: unknown = null;
  try {
    const a = await world(subject.inspect, primary.name, '/framed'); const b = await world(subject.inspect, blocked.name, '/framed');
    const blockedStore = createGmStorage(subject.root, subject.profileId, blocked.id, blocked.digest); await blockedStore.read();
    await mkdir(join(subject.root, 'gm-values', subject.profileId, blocked.id, blocked.digest + '.dpapi.json.pending'));
    await evaluate(subject.inspect.session, b, "GM_addValueChangeListener('blocked',()=>__events.push('unexpected'));true");
    expect(await evaluate(subject.inspect.session, b, "GM_setValue('blocked',1).then(()=>false,error=>error.message.includes('no success'))")).toBe(true);
    expect(await evaluate(subject.inspect.session, b, '__events')).toEqual([]); expect(await blockedStore.read()).toEqual({});
    await evaluate(subject.inspect.session, a, "GM_addValueChangeListener('callback',()=>{throw new TypeError('Authored callback exception');});GM_addValueChangeListener('callback',()=>__events.push('delivered'));true");
    expect(await evaluate(subject.inspect.session, a, "GM_setValue('callback',1).then(()=>false,error=>error.message.includes('durable commit succeeded'))")).toBe(true);
    expect(await evaluate(subject.inspect.session, a, '__events')).toEqual(['delivered']);
    expect(await createGmStorage(subject.root, subject.profileId, primary.id, primary.digest).read()).toEqual({ callback: 1 });
    await evaluate(subject.inspect.session, a, "GM_addValueChangeListener('async',async()=>{throw new TypeError('Authored asynchronous callback exception');});true");
    await evaluate(subject.inspect.session, a, "GM_setValue('async',1).then(()=>true)");
    expect(await evaluate(subject.inspect.session, a, "GM_getTab(()=>{throw new TypeError('Authored tab callback exception');}).then(()=>false,error=>error.message==='GM tab callback failed.')")).toBe(true);
    await expect(subject.controller.flush()).rejects.toThrow('outstanding failures');
    expect(subject.reports.filter(report => report.id === primary.id && report.outcome === 'failed').length).toBeGreaterThanOrEqual(3);
  } catch (cause) { failure = cause; }
  finally { await finish(subject, 'failures', failure, true); }
}, 120000);
