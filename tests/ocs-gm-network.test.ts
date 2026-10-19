import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { ClientRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { z } from 'zod';
import { parseUserScript } from '../desktop/bun/ocs-assets';
import { attachUserScripts } from '../desktop/ocs/userscripts';
import { connectHost, networkHeaders, networkUrl, requestGmNetwork, type GmRequest } from '../desktop/ocs/gm-network';
import { isPublicDownloadAddress } from '../desktop/bun/ocs-download';

const work = process.env['SWU_OCS_NETWORK_WORK'] ?? await mkdtemp(join(resolve(import.meta.dir, '../work'), 'ocs-network-final-'));
const results: { name: string; passed: boolean }[] = [];
const publicResponses: { alias: string; method: string; url: string; status: number; cookieAbsent?: boolean }[] = [];
interface NativeHttpObservation { method: string; host: string; path: string; cookiePresent: boolean; status: number | null; finished: boolean; closed: boolean; error: { name: string; code: string | null; message: string } | null }
const nativeHttp: NativeHttpObservation[] = [];
const nativeWaiters = new Set<() => void>();
function notifyNativeWaiters(): void { for (const notify of nativeWaiters) notify(); }
function waitForNative(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise<void>((accept, reject) => {
    const notify = (): void => { if (predicate()) { clearTimeout(timer); nativeWaiters.delete(notify); accept(); } };
    const timer = setTimeout(() => { nativeWaiters.delete(notify); reject(new Error('Native HTTPS request did not reach the required finish/close boundary within 10 seconds.')); }, 10000);
    nativeWaiters.add(notify);
  });
}
const requestChannel = channel('http.client.request.start');
function observeNativeHttp(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('request' in value) || !(value.request instanceof ClientRequest)) return;
  const request = value.request;
  const host = request.getHeader('host');
  if (typeof host !== 'string' || !['httpbin.org', 'registry.npmjs.org'].includes(host)) return;
  const observation: NativeHttpObservation = { method: request.method, host, path: request.path, cookiePresent: request.hasHeader('cookie'), status: null, finished: request.writableFinished, closed: false, error: null };
  nativeHttp.push(observation);
  request.once('finish', () => { observation.finished = true; notifyNativeWaiters(); });
  request.once('response', response => { observation.status = response.statusCode ?? null; });
  request.once('close', () => { observation.closed = true; notifyNativeWaiters(); });
  request.once('error', (error: Error) => { observation.error = { name: error.name, code: 'code' in error && typeof error.code === 'string' ? error.code : null, message: error.message }; });
  notifyNativeWaiters();
}
requestChannel.subscribe(observeNativeHttp);
afterAll(async () => {
  requestChannel.unsubscribe(observeNativeHttp);
  await writeFile(join(work, 'transport.json'), JSON.stringify({ nativeDiagnosticsObserved: nativeHttp.length > 0, nativeHttp, publicResponses, nativeRequestCount: nativeHttp.length || null, unclosedObservedRequests: nativeHttp.filter(request => !request.closed).length }, null, 2));
});
console.log(JSON.stringify({ event: 'ocs.gm.network.evidence', work }));
async function record(name: string, passed: boolean): Promise<void> {
  results.push({ name, passed });
  await writeFile(join(work, 'result.json'), JSON.stringify({ results, publicResponses, nativeHttp, realChrome: results.some(result => ['public-https', 'lifecycle-boundaries', 'inflight-native', 'public-post'].includes(result.name)), schoolAccounts: false, paidRequests: false, productionPrivateNetworkPolicyUnchanged: true, inheritedTrustVariableNames: ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS'].filter(name => Object.hasOwn(process.env, name)) }, null, 2), 'utf8');
}
function script(name: string, grants: string[], connects: string[]) {
  return parseUserScript(randomUUID(), ['// ==UserScript==', '// @name ' + name, '// @match http://127.0.0.1/*', ...grants.map(grant => '// @grant ' + grant), ...connects.map(host => '// @connect ' + host), '// ==/UserScript==', 'void 0;'].join('\n'));
}
function request(url: string): GmRequest { return { url, method: 'GET', headers: {}, data: null, timeout: 10000, responseType: 'text' }; }

test('GM network metadata is exact, fail-closed and never fetches dependencies', () => {
  for (const grant of ['GM_xmlhttpRequest', 'GM.xmlHttpRequest']) {
    expect(script('valid', [grant], ['httpbin.org']).supported).toBe(true);
    expect(script('missing connect', [grant], []).supported).toBe(false);
    for (const host of ['*', '*.example.com', 'self', 'localhost', '127.0.0.1', '169.254.169.254', 'example.com:443', 'https://example.com', 'EXAMPLE.COM', 'example.com.', 'foo.local', 'foo.internal', 'foo.lan']) {
      expect(script('invalid', [grant], [host]).supported).toBe(false);
      expect(() => connectHost(host)).toThrow();
    }
    const valid = script('source identity', [grant], ['httpbin.org']);
    expect(parseUserScript(valid.id, valid.content.replace('httpbin.org', 'example.com')).digest).not.toBe(valid.digest);
    for (const declaration of ['// @require https://example.com/dependency.js', '// @resource css https://example.com/style.css', '// @grant unsafeWindow', '// @grant UnknownPermission']) expect(parseUserScript(valid.id, valid.content.replace('// ==/UserScript==', declaration + '\n// ==/UserScript==')).supported).toBe(false);
  }
  expect(script('no network alias', ['GM_info'], ['example.com']).supported).toBe(false);
});

test('GM network rejects local, metadata, credential, protocol, header and explicit port escapes before any fixture request', async () => {
  let received = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { received += 1; return new Response('Must not be reached'); } });
  try {
    for (const target of [`http://127.0.0.1:${server.port}/`, `https://127.0.0.1:${server.port}/`, 'https://169.254.169.254/', 'https://[::1]/', 'https://user:private@example.com/', 'ftp://example.com/', 'http://example.com/', 'https://example.com:444/', 'https://example.com/#fragment', 'https://not-reviewed.example/']) await expect(requestGmNetwork(request(target), ['example.com', '127.0.0.1'], new AbortController().signal, async () => {})).rejects.toThrow();
    for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '198.18.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:8.8.8.8', '2001:db8::1']) expect(isPublicDownloadAddress(address)).toBe(false);
    for (const name of ['Host', 'Cookie', 'Authorization\r\nInjected', 'Proxy-Authorization', 'Content-Length', 'Transfer-Encoding', 'Origin', 'Referer', 'X-Forwarded-For', 'Sec-Fetch-Site', 'Accept-Encoding']) expect(() => networkHeaders({ [name]: 'denied' })).toThrow();
    expect(() => networkHeaders({ Accept: 'text/plain', accept: 'text/html' })).toThrow();
    expect(() => networkHeaders({ Accept: 'text/plain\r\nInjected: denied' })).toThrow();
    expect(() => networkUrl('https://sub.example.com/', ['example.com'])).toThrow();
    expect(received).toBe(0);
    await record('private-boundaries', true);
  } finally { await server.stop(true); }
});

const integration = process.env['SWU_OCS_GM_NETWORK_TEST'] === '1' ? test : test.skip;
const nativeSchema = z.object({ id: z.number().int(), uniqueId: z.string(), name: z.string() });
type NativeWorld = z.infer<typeof nativeSchema>;
async function inspect(page: Page) {
  const session = await page.context().newCDPSession(page); const worlds = new Map<number, NativeWorld>();
  session.on('Runtime.executionContextCreated', (raw: unknown) => { const item = z.object({ context: nativeSchema }).parse(raw).context; worlds.set(item.id, item); });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  session.on('Runtime.executionContextDestroyed', (raw: unknown) => worlds.delete(z.object({ executionContextId: z.number() }).parse(raw).executionContextId));
  await session.send('Runtime.enable'); return { session, worlds };
}
async function evaluate(session: CDPSession, world: NativeWorld, expression: string): Promise<unknown> {
  const reply = await session.send('Runtime.evaluate', { uniqueContextId: world.uniqueId, expression, returnByValue: true, awaitPromise: true, timeout: 30000 });
  if (reply.exceptionDetails) throw new Error('Authored GM network integration expression failed: ' + (reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text));
  return reply.result.value as unknown;
}
async function findWorld(inspector: Awaited<ReturnType<typeof inspect>>, name: string): Promise<NativeWorld> {
  for (const world of inspector.worlds.values()) if (world.name.startsWith('swu-gm-') && await evaluate(inspector.session, world, `typeof GM_info==='object'&&GM_info.script.name===${JSON.stringify(name)}`)) return world;
  throw new Error('Reviewed isolated GM network world is missing.');
}
async function fixture(name: string) {
  const executablePath = process.env['SWU_OCS_BROWSER']; if (!executablePath) throw new Error('Explicit real Chrome executable is required.');
  const root = join(work, name); await mkdir(root);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('<!doctype html><html><head></head><body><div id="owned-page">GM network authored document</div></body></html>', { headers: { 'content-type': 'text/html' } }); } });
  const context = await chromium.launchPersistentContext(join(root, 'chrome'), { executablePath, headless: true, serviceWorkers: 'block', args: ['--no-first-run', '--disable-background-networking'] });
  const a = script('Legacy', ['GM_info', 'GM_xmlhttpRequest'], ['httpbin.org']);
const b = script('Promise', ['GM_info', 'GM.xmlHttpRequest'], ['httpbin.org', 'registry.npmjs.org']);
  const c = script('No network', ['GM_info'], []);
  const reports: string[] = [];
  const controller = await attachUserScripts(context, [a, b, c], (id, outcome) => reports.push(id + ':' + outcome), { root, profileId: randomUUID() });
  const page = context.pages()[0]; if (!page) throw new Error('Real Chrome initial page is missing.');
  const inspector = await inspect(page); await page.goto(`http://127.0.0.1:${server.port}/`); await controller.flush();
  return { context, server, controller, page, inspector, reports, a: await findWorld(inspector, a.name), b: await findWorld(inspector, b.name), c: await findWorld(inspector, c.name) };
}
async function finish(subject: Awaited<ReturnType<typeof fixture>>, name: string, failure: unknown): Promise<void> {
  const errors: unknown[] = failure === null ? [] : [failure];
  try { await subject.controller.dispose(); expect(subject.controller.isSettled()).toBe(true); } catch (cause) { errors.push(cause); }
  try { await subject.context.close(); } catch (cause) { errors.push(cause); }
  await subject.server.stop(true); await record(name, errors.length === 0);
  if (errors.length) throw new AggregateError(errors, 'Real GM network integration failed; owned Chrome closed normally.');
}

integration('GM network real Chrome performs public HTTPS callbacks and Promise text/JSON without cookies or ungranted aliases', async () => {
  const subject = await fixture('public-https'); let failure: unknown = null;
  try {
    expect(await evaluate(subject.inspector.session, subject.a, "typeof GM_xmlhttpRequest+':'+typeof GM")).toBe('function:undefined');
    expect(await evaluate(subject.inspector.session, subject.b, "typeof GM_xmlhttpRequest+':'+typeof GM.xmlHttpRequest")).toBe('undefined:function');
    expect(await evaluate(subject.inspector.session, subject.c, "typeof GM_xmlhttpRequest+':'+typeof GM")).toBe('undefined:undefined');
    expect(await subject.page.evaluate(() => typeof Reflect.get(globalThis, 'GM') + ':' + typeof Reflect.get(globalThis, 'GM_xmlhttpRequest'))).toBe('undefined:undefined');
    await subject.context.addCookies([{ name: 'must_not_leak', value: 'authored-test-marker', domain: 'httpbin.org', path: '/', secure: true }]);
    const response = await evaluate(subject.inspector.session, subject.a, `new Promise((resolve,reject)=>GM_xmlhttpRequest({url:'https://httpbin.org/get',onload:r=>resolve({status:r.status,body:r.responseText,readyState:r.readyState}),onerror:r=>reject(new Error(r.error)),ontimeout:r=>reject(new Error(r.error))}))`);
    const parsed = z.object({ status: z.literal(200), readyState: z.literal(4), body: z.string() }).parse(response);
    const echoed = z.object({ headers: z.record(z.string(), z.string()) }).parse(JSON.parse(parsed.body));
    expect(Object.keys(echoed.headers).some(name => name.toLowerCase() === 'cookie')).toBe(false);
    publicResponses.push({ alias: 'GM_xmlhttpRequest', method: 'GET', url: 'https://httpbin.org/get', status: parsed.status, cookieAbsent: true });
    const json = z.object({ status: z.literal(200), response: z.object({ method: z.literal('GET') }) }).parse(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/anything',responseType:'json'}).then(r=>({status:r.status,response:{method:r.response.method}}))"));
    expect(json.response.method).toBe('GET');
    publicResponses.push({ alias: 'GM.xmlHttpRequest', method: 'GET', url: 'https://httpbin.org/anything', status: json.status });
    const status = await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/status/418'}).then(r=>r.status)");
    expect(status).toBe(418);
    publicResponses.push({ alias: 'GM.xmlHttpRequest', method: 'GET', url: 'https://httpbin.org/status/418', status: 418 });
    expect(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/get',method:'HEAD'}).then(r=>({status:r.status,text:r.responseText}))")).toEqual({ status: 200, text: '' });
    publicResponses.push({ alias: 'GM.xmlHttpRequest', method: 'HEAD', url: 'https://httpbin.org/get', status: 200 });
    await subject.controller.flush(); expect(subject.reports.some(value => value.endsWith(':failed'))).toBe(false);
  } catch (cause) { failure = cause; } finally { await finish(subject, 'public-https', failure); }
}, 120000);

integration('GM network real Chrome denies redirects/headers/limits and settles abort timeout SPA revoke and dispose', async () => {
  if (!publicResponses.some(response => response.alias === 'GM_xmlhttpRequest') || !publicResponses.some(response => response.alias === 'GM.xmlHttpRequest')) throw new Error('Public GET prerequisites did not pass; no additional public requests were sent.');
  const subject = await fixture('lifecycle-boundaries'); let failure: unknown = null;
  try {
    for (const options of [
      { url: `http://127.0.0.1:${subject.server.port}/` }, { url: 'https://example.com/' },
      { url: 'https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com' },
      { url: 'https://httpbin.org/redirect-to?url=https%3A%2F%2F127.0.0.1' },
      { url: 'https://httpbin.org/get', headers: { Cookie: 'not-forwarded' } }
    ]) expect(await evaluate(subject.inspector.session, subject.b, `GM.xmlHttpRequest(${JSON.stringify(options)}).then(()=>false,e=>e.name==='NetworkError')`)).toBe(true);
    expect(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/redirect/1'}).then(r=>r.status)")).toBe(200);
    publicResponses.push({ alias: 'GM.xmlHttpRequest', method: 'GET', url: 'https://httpbin.org/redirect/1', status: 200 });
    expect(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/get',responseType:'json',timeout:1}).then(()=>false,e=>e.name==='TimeoutError')")).toBe(true);
    expect(await evaluate(subject.inspector.session, subject.b, "(()=>{const op=GM.xmlHttpRequest({url:'https://httpbin.org/delay/5'});op.abort();return op.then(()=>false,e=>e.name==='AbortError');})()")).toBe(true);
    for (const options of [{ url: 'https://httpbin.org/get', responseType: 'arraybuffer' }, { url: 'https://httpbin.org/get', anonymous: false }, { url: 'https://httpbin.org/get', timeout: 20001 }, { url: 'https://httpbin.org/post', method: 'POST', data: 'x'.repeat(32769) }]) expect(await evaluate(subject.inspector.session, subject.b, `(()=>{try{GM.xmlHttpRequest(${JSON.stringify(options)});return false;}catch(e){return e instanceof TypeError;}})()`)).toBe(true);
    expect(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://registry.npmjs.org/typescript'}).then(()=>false,e=>e.name==='NetworkError')")).toBe(true);
    await evaluate(subject.inspector.session, subject.b, "globalThis.__revokedResult=GM.xmlHttpRequest({url:'https://httpbin.org/delay/5'}).then(()=>false,e=>e.name==='AbortError');true");
    await subject.page.evaluate(() => history.pushState(null, '', '/changed'));
    expect(await evaluate(subject.inspector.session, subject.b, '__revokedResult')).toBe(true);
    expect(await evaluate(subject.inspector.session, subject.b, "(()=>{try{GM.xmlHttpRequest({url:'https://httpbin.org/get'});return false;}catch(e){return e.name==='AbortError';}})()")).toBe(true);
    await subject.page.goto(`http://127.0.0.1:${subject.server.port}/fresh`); await subject.controller.flush();
    const fresh = await findWorld(subject.inspector, 'Promise');
    await evaluate(subject.inspector.session, fresh, "globalThis.__disposedResult=GM.xmlHttpRequest({url:'https://httpbin.org/delay/5'}).then(()=>false,e=>e.name==='AbortError');true");
    await subject.controller.dispose(); expect(subject.controller.isSettled()).toBe(true);
    expect(await evaluate(subject.inspector.session, fresh, '__disposedResult')).toBe(true);
  } catch (cause) { failure = cause; } finally { await finish(subject, 'lifecycle-boundaries', failure); }
}, 180000);

integration('GM network real Chrome aborts already-sent HTTPS on explicit abort, SPA revocation and dispose', async () => {
  const subject = await fixture('inflight-native'); let failure: unknown = null;
  const before = nativeHttp.length;
  try {
    await evaluate(subject.inspector.session, subject.b, "globalThis.__inflight=GM.xmlHttpRequest({url:'https://httpbin.org/delay/5'});globalThis.__inflightResult=__inflight.then(()=>false,error=>error.name==='AbortError');true");
    await waitForNative(() => nativeHttp.length > before && nativeHttp[before]?.finished === true);
    expect(nativeHttp[before]?.status).toBeNull();
    await evaluate(subject.inspector.session, subject.b, '__inflight.abort();true');
    expect(await evaluate(subject.inspector.session, subject.b, '__inflightResult')).toBe(true);
    await subject.controller.flush();
    await waitForNative(() => nativeHttp[before]?.closed === true);
    expect(nativeHttp[before]?.error?.name).toBe('AbortError');

    await evaluate(subject.inspector.session, subject.b, "globalThis.__spaResult=GM.xmlHttpRequest({url:'https://httpbin.org/delay/5'}).then(()=>false,error=>error.name==='AbortError');true");
    await waitForNative(() => nativeHttp.length > before + 1 && nativeHttp[before + 1]?.finished === true);
    expect(nativeHttp[before + 1]?.status).toBeNull();
    await subject.page.evaluate(() => history.pushState(null, '', '/inflight-revoked'));
    expect(await evaluate(subject.inspector.session, subject.b, '__spaResult')).toBe(true);
    await subject.controller.flush();
    await waitForNative(() => nativeHttp[before + 1]?.closed === true);
    await subject.page.evaluate(() => history.replaceState(null, '', '/'));
    expect(await evaluate(subject.inspector.session, subject.b, "(()=>{try{GM.xmlHttpRequest({url:'https://httpbin.org/get'});return false;}catch(error){return error.name==='AbortError';}})()")).toBe(true);

    await subject.page.goto(`http://127.0.0.1:${subject.server.port}/inflight-fresh`); await subject.controller.flush();
    const fresh = await findWorld(subject.inspector, 'Promise');
    await evaluate(subject.inspector.session, fresh, "globalThis.__disposeResult=GM.xmlHttpRequest({url:'https://httpbin.org/delay/5'}).then(()=>false,error=>error.name==='AbortError');true");
    await waitForNative(() => nativeHttp.length > before + 2 && nativeHttp[before + 2]?.finished === true);
    expect(nativeHttp[before + 2]?.status).toBeNull();
    await subject.controller.dispose();
    expect(subject.controller.isSettled()).toBe(true);
    expect(await evaluate(subject.inspector.session, fresh, '__disposeResult')).toBe(true);
    await waitForNative(() => nativeHttp[before + 2]?.closed === true);
    expect(nativeHttp.slice(before).map(request => ({ method: request.method, path: request.path, finished: request.finished, closed: request.closed, cookiePresent: request.cookiePresent, aborted: request.error?.name === 'AbortError' }))).toEqual(Array.from({ length: 3 }, () => ({ method: 'GET', path: '/delay/5', finished: true, closed: true, cookiePresent: false, aborted: true })));
    await writeFile(join(work, 'inflight-evidence.json'), JSON.stringify({ realChrome: true, nativeRequests: nativeHttp.slice(before), durableOwnerSettled: subject.controller.isSettled(), cancelledBeforeResponse: true, postRequests: 0, platformSuccessClaimed: false }, null, 2));
  } catch (cause) { failure = cause; } finally { await finish(subject, 'inflight-native', failure); }
}, 90000);

const postIntegration = process.env['SWU_OCS_GM_NETWORK_POST_TEST'] === '1' ? test : test.skip;
postIntegration('GM network real Chrome POST and no-replay redirect require separate explicit authorization', async () => {
  const subject = await fixture('public-post'); let failure: unknown = null;
  try {
    expect(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/anything',method:'POST',headers:{'Content-Type':'text/plain'},data:'authored GM network smoke',responseType:'json'}).then(r=>({method:r.response.method,data:r.response.data}))")).toEqual({ method: 'POST', data: 'authored GM network smoke' });
    expect(await evaluate(subject.inspector.session, subject.b, "GM.xmlHttpRequest({url:'https://httpbin.org/redirect-to?url=https%3A%2F%2Fhttpbin.org%2Fget',method:'POST',data:'no replay'}).then(()=>false,e=>e.name==='NetworkError')")).toBe(true);
  } catch (cause) { failure = cause; } finally { await finish(subject, 'public-post', failure); }
}, 120000);
