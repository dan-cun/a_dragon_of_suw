import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { chromium, type CDPSession } from 'playwright-core';
import { z } from 'zod';
import { importScript, loadScript, parseUserScript } from '../desktop/bun/ocs-assets';
import { ocsStyleResourceUrl, resolveScriptResources } from '../desktop/bun/ocs-script-resources';
import { createGmStorage } from '../desktop/bun/ocs-gm-storage';
import { attachUserScripts } from '../desktop/ocs/userscripts';

const work = process.env['SWU_OCS_RESOURCE_WORK'] ?? await mkdtemp(join(resolve(import.meta.dir, '../work'), 'ocs-resource-'));
if (!isAbsolute(work)) throw new TypeError('Resource evidence directory must be absolute.');
console.log(JSON.stringify({ event: 'ocs.resource.evidence', work }));
const results: { name: string; passed: boolean }[] = [];
async function record(name: string, passed: boolean): Promise<void> {
  results.push({ name, passed });
  await writeFile(join(work, 'result.json'), JSON.stringify({ results, schoolAccounts: false, paidRequests: false, platformSuccessClaimed: false, remoteResourcesFetched: false }, null, 2));
}
function inline(text: string): string { return 'data:text/plain;charset=utf-8;base64,' + Buffer.from(text).toString('base64'); }
function source(name: string, declarations: string[], body: string): string {
  return ['// ==UserScript==', '// @name ' + name, '// @match http://127.0.0.1/*', '// @run-at document-end', ...declarations.map(value => '// @' + value), '// ==/UserScript==', body].join('\n');
}
function hash(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }

test('OCS resources: actual pinned stylesheet is byte-exact, imported without network and bound to source digest', async () => {
  const root = join(work, 'imported'); await mkdir(join(root, 'scripts'), { recursive: true });
  const original = await readFile(resolve(import.meta.dir, '../vendor/ocs/ocsjs-5.2.1/packages/scripts/assets/css/style.css'));
  const content = source('Resource import', ['grant GM_getResourceText', 'resource STYLE ' + ocsStyleResourceUrl], 'void 0;');
  const saved = await importScript(root, content, 'local-authored');
  expect(saved.enabled).toBe(true);
  const loaded = await loadScript(root, saved);
  expect(loaded.resources).toHaveLength(1);
  expect(loaded.resources[0]?.text).toBe(original.toString('utf8'));
  expect(loaded.resources[0]?.digest).toBe(hash(original));
  expect(loaded.resources[0]?.dataUrl).toBe('data:text/css;charset=utf-8;base64,' + original.toString('base64'));
  const changed = parseUserScript(saved.id, content.replace(ocsStyleResourceUrl, inline('different')));
  expect(changed.supported).toBe(true);
  expect(changed.digest).not.toBe(loaded.digest);
  await writeFile(join(root, 'scripts', saved.id + '.user.js'), changed.content);
  await expect(loadScript(root, saved)).rejects.toThrow('校验失败');
  await record('pinned-import-and-digest', true);
});

test('OCS resources: strict names, fixed sources, canonical UTF-8 data, and bounded expansion fail closed', async () => {
  const allowed = ['grant GM_getResourceText', 'grant GM_getResourceURL', 'resource NOTE ' + inline('实际资源 😀\n` ${notExecuted} </script>')];
  const parsed = parseUserScript(randomUUID(), source('Inline resources', allowed, 'void 0;'));
  expect(parsed.supported).toBe(true);
  expect(parsed.resources[0]?.text).toBe('实际资源 😀\n` ${notExecuted} </script>');
  for (const target of ['https://cdn.ocsjs.com/style.css', ocsStyleResourceUrl + '?changed=1', ocsStyleResourceUrl.replace('8b25a3f44523a0d4b7373878488056f4aa478cf6', 'main'), 'file:///C:/Windows/win.ini', 'http://127.0.0.1/private', 'data:text/html;charset=utf-8;base64,PHNjcmlwdD4=', 'data:text/javascript;charset=utf-8;base64,dm9pZCAw', 'data:text/plain,unbounded-percent', 'data:text/plain;charset=utf-8;base64,YQ', 'data:text/plain;charset=utf-8;base64,YR==']) {
    expect(parseUserScript(randomUUID(), source('Rejected source', ['grant GM_getResourceText', 'resource NOTE ' + target], 'void 0;')).supported).toBe(false);
  }
  for (const name of ['__proto__', 'constructor', 'prototype', 'bad/name', 'a'.repeat(65)]) expect(resolveScriptResources([name + ' ' + inline('x')]).error).not.toBeNull();
  expect(resolveScriptResources(['NOTE ' + inline('a'), 'NOTE ' + inline('b')]).error).not.toBeNull();
  expect(resolveScriptResources(Array.from({ length: 17 }, (_, index) => 'R' + index + ' ' + inline('a'))).error).not.toBeNull();
  expect(resolveScriptResources(['LIMIT ' + inline('a'.repeat(65_536))]).error).toBeNull();
  expect(resolveScriptResources(['LIMIT ' + inline('a'.repeat(65_537))]).error).not.toBeNull();
  expect(resolveScriptResources(Array.from({ length: 4 }, (_, index) => 'R' + index + ' ' + inline('a'.repeat(65_536)))).error).toBeNull();
  expect(resolveScriptResources(Array.from({ length: 5 }, (_, index) => 'R' + index + ' ' + inline('a'.repeat(65_536)))).error).not.toBeNull();
  expect(() => resolveScriptResources(['BAD data:text/plain;charset=utf-8;base64,/w=='])).toThrow('invalid UTF-8');
  expect(parseUserScript(randomUUID(), source('Still unsupported', allowed.concat('require https://cdn.ocsjs.com/index.js'), 'void 0;')).supported).toBe(false);
  expect(parseUserScript(randomUUID(), source('Still unsafe', allowed.concat('grant unsafeWindow'), 'void 0;')).supported).toBe(false);
  expect(parseUserScript(randomUUID(), source('Still local connect', allowed.concat('grant GM_xmlhttpRequest', 'connect localhost'), 'void 0;')).supported).toBe(false);
  await record('metadata-and-byte-limits', true);
});

const integration = process.env['SWU_OCS_RESOURCE_TEST'] === '1' ? test : test.skip;
const worldSchema = z.object({ id: z.number().int(), uniqueId: z.string(), name: z.string() });
type NativeWorld = z.infer<typeof worldSchema>;
async function evaluate(session: CDPSession, world: NativeWorld, expression: string): Promise<unknown> {
  const result = await session.send('Runtime.evaluate', { uniqueContextId: world.uniqueId, expression, returnByValue: true, awaitPromise: true, timeout: 10000 });
  if (result.exceptionDetails) throw new Error('Authored resource integration expression failed: ' + (result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
  return result.result.value as unknown;
}

integration('OCS resources: real Chrome executes declared resources with DPAPI, exact grants, page isolation and irreversible revocation', async () => {
  const executablePath = process.env['SWU_OCS_BROWSER'];
  if (!executablePath || !isAbsolute(executablePath)) throw new Error('An explicit absolute real Chrome executable is required.');
  const root = join(work, 'chrome-resource'); const profileId = randomUUID();
  const marker = 'resource-only-' + randomUUID();
  const primary = parseUserScript(randomUUID(), source('Resource primary', ['grant GM_info', 'grant GM_getResourceText', 'grant GM_getResourceURL', 'grant GM_addStyle', 'grant GM_setValue', 'resource STYLE ' + ocsStyleResourceUrl, 'resource NOTE ' + inline(marker)], `GM_addStyle(GM_getResourceText('STYLE')); void (async()=>{ const value=await fetch(GM_getResourceURL('NOTE')).then(response=>response.text()); if(value!==GM_getResourceText('NOTE'))throw new Error('Resource URL bytes differ'); await GM_setValue('resourceValue',value); document.documentElement.dataset.resourceReady='yes'; })();`));
  const sibling = parseUserScript(randomUUID(), source('Resource sibling', ['grant GM_info', 'grant GM_getResourceText', 'resource NOTE ' + inline('sibling-owned')], 'void 0;'));
  const noGrant = parseUserScript(randomUUID(), source('No resource grant', ['grant GM_info', 'resource NOTE ' + inline('not-granted')], 'void 0;'));
  let fixtureRequests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { fixtureRequests += 1; return new Response('<!doctype html><html><head></head><body><a id="resource-color">Local integration</a></body></html>', { headers: { 'Content-Type': 'text/html' } }); } });
  const context = await chromium.launchPersistentContext(join(root, 'profile'), { executablePath, headless: true, serviceWorkers: 'block', args: ['--disable-background-networking', '--no-first-run'] });
  let externalRequests = 0;
  await context.route('**/*', async route => {
    if (new URL(route.request().url()).origin === `http://127.0.0.1:${server.port}`) await route.continue();
    else { externalRequests += 1; await route.abort('blockedbyclient'); }
  });
  let controller: Awaited<ReturnType<typeof attachUserScripts>> | null = null;
  const reports: { id: string; outcome: string }[] = [];
  const errors: unknown[] = [];
  try {
    // The host must derive resources from reviewed source, never caller-supplied metadata.
    controller = await attachUserScripts(context, [primary, { ...sibling, resources: primary.resources }, noGrant], (id, outcome) => { reports.push({ id, outcome }); }, { root, profileId });
    const page = context.pages()[0]; if (!page) throw new Error('Real Chrome initial page is missing.');
    const session = await context.newCDPSession(page); const worlds = new Map<number, NativeWorld>();
    session.on('Runtime.executionContextCreated', (raw: unknown) => { const world = z.object({ context: worldSchema }).parse(raw).context; worlds.set(world.id, world); });
    session.on('Runtime.executionContextsCleared', () => worlds.clear());
    session.on('Runtime.executionContextDestroyed', (raw: unknown) => worlds.delete(z.object({ executionContextId: z.number() }).parse(raw).executionContextId));
    await session.send('Runtime.enable');
    await page.goto(`http://127.0.0.1:${server.port}/resources`);
    await page.locator('html[data-resource-ready="yes"]').waitFor({ state: 'attached', timeout: 20000 });
    await controller.flush();
    async function find(name: string): Promise<NativeWorld> {
      for (const world of worlds.values()) if (world.name.startsWith('swu-gm-') && await evaluate(session, world, `typeof GM_info==='object'&&GM_info.script.name===${JSON.stringify(name)}`)) return world;
      throw new Error('Exact resource script world is missing: ' + name);
    }
    const a = await find(primary.name); const b = await find(sibling.name); const c = await find(noGrant.name);
    expect(await page.locator('#resource-color').evaluate(element => getComputedStyle(element).color)).toBe('rgb(43, 103, 255)');
    expect(await evaluate(session, a, "fetch(GM_getResourceURL('STYLE')).then(response=>response.text()).then(text=>text===GM_getResourceText('STYLE'))")).toBe(true);
    expect(await evaluate(session, a, "GM_info.script.resources.map(item=>item.name)")).toEqual(['STYLE', 'NOTE']);
    expect(await evaluate(session, b, "GM_getResourceText('NOTE')")).toBe('sibling-owned');
    expect(await evaluate(session, b, 'typeof GM_getResourceURL')).toBe('undefined');
    expect(await evaluate(session, c, 'typeof GM_getResourceText+":"+typeof GM_getResourceURL')).toBe('undefined:undefined');
    expect(await page.evaluate(() => typeof Reflect.get(globalThis, 'GM_getResourceText') + ':' + typeof Reflect.get(globalThis, 'GM_getResourceURL'))).toBe('undefined:undefined');
    expect(await evaluate(session, a, "(()=>{try{GM_getResourceText('missing');return false;}catch(error){return error instanceof ReferenceError;}})()")).toBe(true);
    expect(await evaluate(session, a, "(()=>{try{GM_getResourceURL({});return false;}catch(error){return error instanceof TypeError;}})()")).toBe(true);
    expect(await evaluate(session, b, "(()=>{try{GM_getResourceText('STYLE');return false;}catch(error){return error instanceof ReferenceError;}})()")).toBe(true);
    expect(await createGmStorage(root, profileId, primary.id, primary.digest).read()).toEqual({ resourceValue: marker });
    const encrypted = await readFile(join(root, 'gm-values', profileId, primary.id, primary.digest + '.dpapi.json'));
    expect(encrypted.includes(Buffer.from(marker))).toBe(false);
    expect(await createGmStorage(root, randomUUID(), primary.id, primary.digest).read()).toEqual({});
    expect(await createGmStorage(root, profileId, sibling.id, sibling.digest).read()).toEqual({});
    await page.evaluate(() => history.pushState(null, '', '#revoked'));
    expect(await evaluate(session, a, "(()=>{try{GM_getResourceText('NOTE');return false;}catch(error){return error.name==='AbortError';}})()")).toBe(true);
    await page.evaluate(() => history.replaceState(null, '', '/resources'));
    expect(await evaluate(session, a, "(()=>{try{GM_getResourceURL('NOTE');return false;}catch(error){return error.name==='AbortError';}})()")).toBe(true);
    await controller.dispose();
    expect(controller.isSettled()).toBe(true);
    expect(await evaluate(session, b, "(()=>{try{GM_getResourceText('NOTE');return false;}catch(error){return error.name==='AbortError';}})()")).toBe(true);
    expect(externalRequests).toBe(0);
    expect(fixtureRequests).toBeGreaterThan(0);
    expect(reports.filter(report => report.outcome === 'failed')).toEqual([]);
    await writeFile(join(work, 'chrome-evidence.json'), JSON.stringify({ realChrome: true, realDpapi: true, externalRequests, fixtureRequests, normalDisposeSettled: controller.isSettled(), reports, schoolAccounts: false }, null, 2));
  } catch (cause) { errors.push(cause); }
  finally {
    try { await controller?.dispose(); } catch (cause) { errors.push(cause); }
    try { await context.close(); } catch (cause) { errors.push(cause); }
    await server.stop(true);
    await record('real-chrome-resource-runtime', errors.length === 0);
  }
  if (errors.length) throw new AggregateError(errors, 'Real resource integration or normal cleanup failed.');
}, 120000);

test('OCS resources: compiled Bun executable embeds verified pinned CSS without runtime vendor files', async () => {
  const entry = join(work, 'resource-compiled.ts'); const executable = join(work, 'resource-compiled.exe');
  const assetsModule = resolve(import.meta.dir, '../desktop/bun/ocs-assets.ts');
  const content = source('Compiled resources', ['grant GM_getResourceText', 'resource STYLE ' + ocsStyleResourceUrl], 'void 0;');
  await writeFile(entry, `import {parseUserScript} from ${JSON.stringify(assetsModule)}; const program=parseUserScript('compiled',${JSON.stringify(content)}); if(!program.supported||program.resources[0]?.digest!=='09c6293d7ba97e19446d36668e2c208abed7a970e9e099ebe6a6c155840d10ed')throw new Error('Compiled pinned resource mismatch');console.log(JSON.stringify({supported:program.supported,bytes:Buffer.byteLength(program.resources[0].text),digest:program.resources[0].digest}));`);
  const build = Bun.spawn([process.execPath, 'build', entry, '--compile', '--outfile', executable], { cwd: work, stdout: 'pipe', stderr: 'pipe' });
  const [buildOut, buildError, buildExit] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  await writeFile(join(work, 'compiled-build.log'), buildOut + buildError); expect(buildExit).toBe(0);
  const run = Bun.spawn([executable], { cwd: work, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
  await writeFile(join(work, 'compiled-run.log'), stdout + stderr); expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({ supported: true, bytes: 55985, digest: '09c6293d7ba97e19446d36668e2c208abed7a970e9e099ebe6a6c155840d10ed' });
  await record('compiled-resource-asset', true);
}, 120000);
