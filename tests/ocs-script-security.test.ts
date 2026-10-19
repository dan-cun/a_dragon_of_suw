import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import { attachUserScripts } from '../desktop/ocs/userscripts';
import { createOcsService } from '../desktop/bun/ocs';
import { createOcsRepository } from '../desktop/bun/ocs-storage';
import { loadScript, parseUserScript, scriptDigest } from '../desktop/bun/ocs-assets';
import { createGmStorage } from '../desktop/bun/ocs-gm-storage';
import { parseOcsConfigJson, writeOcsConfigField } from '../desktop/shared/ocs-config';

const work = await mkdtemp(join(resolve(import.meta.dir, '../work'), 'ocs-script-security-'));
const evidence: { test: string; passed: boolean; at: string }[] = [];

async function record(name: string, passed: boolean): Promise<void> {
  evidence.push({ test: name, passed, at: new Date().toISOString() });
  await writeFile(join(work, 'security-result.json'), JSON.stringify({ evidence, realAccountUsed: false, externalRequestsRequired: false }, null, 2) + '\n', 'utf8');
}

function scriptSource(name: string, declarations: string[], body: string): string {
  return ['// ==UserScript==', `// @name ${name}`, '// @match http://127.0.0.1/*', ...declarations.map(value => '// ' + value), '// ==/UserScript==', body].join('\n');
}

const browserMetadata = { name: 'Security integration only', folder: '', notes: 'Authored local pages; no real accounts', tags: ['security'], startUrl: 'about:blank' };

test('Security: unsupported privileges stay disabled and source tampering fails before execution', async () => {
  const name = 'unsupported-capabilities-and-digest';
  const directory = join(work, 'metadata');
  const service = createOcsService(directory);
  let passed = false;
  try {
    for (const declaration of ['@grant GM_xmlhttpRequest', '@grant GM.xmlHttpRequest', '@grant unsafeWindow', '@grant GM_openInTab', '@grant UnknownPermission', '@require https://example.invalid/never-requested.js', '@resource private https://example.invalid/never-requested.txt']) {
      const before = await service.execute({ command: 'state' });
      const imported = await service.execute({ command: 'script-import', name: declaration, content: scriptSource('Untrusted capability', [declaration], 'void 0;') });
      const item = imported.userScripts.find(value => !before.userScripts.some(prior => prior.id === value.id));
      if (!item) throw new Error('The imported unsupported script is missing.');
      expect(item.enabled).toBe(false);
      await expect(service.execute({ command: 'script-enable', id: item.id, enabled: true })).rejects.toThrow();
    }
    const content = scriptSource('Digest checked source', ['@grant none'], 'void 0;');
    const imported = await service.execute({ command: 'script-import', name: 'Digest checked source', content });
    const item = imported.userScripts.find(value => value.name === 'Digest checked source');
    if (!item) throw new Error('The digest integration script is missing.');
    const repository = createOcsRepository(directory);
    const saved = (await repository.read()).userScripts.find(value => value.id === item.id);
    if (!saved) throw new Error('The saved digest metadata is missing.');
    await writeFile(join(repository.root, 'scripts', item.id + '.user.js'), content + '\nvoid 1;', 'utf8');
    await expect(loadScript(repository.root, saved)).rejects.toThrow('校验失败');
    passed = true;
  } finally {
    await service.close();
    await record(name, passed);
  }
}, 120_000);

test('Security: scalar configuration edits preserve unknown objects, arrays and DPAPI private placeholders', async () => {
  const name = 'configuration-private-placeholder-roundtrip';
  const directory = join(work, 'configuration');
  const service = createOcsService(directory);
  let passed = false;
  try {
    const secret = 'integration-only-' + randomUUID();
    const original = {
      'common.settings.thread': 1,
      'cx.new.study.volume': { apiKey: secret, values: [false, { token: secret }] },
      'unrecognized.namespace': { untouched: [null, 3, { apiKey: secret, nested: ['keep-order', true] }] }
    };
    const initial = await service.execute({ command: 'state' });
    const saved = await service.execute({ command: 'settings-save', settings: { ...initial.settings, globalConfigJson: JSON.stringify(original) } });
    expect(saved.settings.globalConfigJson.includes(secret)).toBe(false);
    const before = parseOcsConfigJson(saved.settings.globalConfigJson);
    const editedJson = writeOcsConfigField(saved.settings.globalConfigJson, 'common.settings.thread', 2);
    const after = parseOcsConfigJson(editedJson);
    expect(after['unrecognized.namespace']).toEqual(before['unrecognized.namespace']);
    expect(after['cx.new.study.volume']).toEqual(before['cx.new.study.volume']);
    expect(() => writeOcsConfigField(editedJson, 'cx.new.study.volume', 0.5)).toThrow('私有占位值');
    expect(() => writeOcsConfigField(editedJson, 'unrecognized.namespace', true)).toThrow();
    const edited = await service.execute({ command: 'settings-save', settings: { ...saved.settings, globalConfigJson: editedJson } });
    expect(edited.settings.globalConfigJson.includes(secret)).toBe(false);
    const document = await createOcsRepository(directory).read();
    expect(parseOcsConfigJson(document.settings.globalConfigJson)).toEqual({ ...original, 'common.settings.thread': 2 });
    const encrypted = await readFile(join(directory, 'ocs', 'source-integration', 'configuration.dpapi.json'), 'utf8');
    expect(encrypted.includes(secret)).toBe(false);
    passed = true;
  } finally {
    await service.close();
    await record(name, passed);
  }
}, 120_000);

test('Security: real GM DPAPI stores isolate script, profile and exact source digest', async () => {
  const name = 'gm-dpapi-identity-isolation';
  const root = join(work, 'gm-identity');
  const profile = randomUUID();
  const script = randomUUID();
  const digest = scriptDigest('independent-security-integration-v1');
  const marker = 'integration-only-' + randomUUID();
  let passed = false;
  try {
    const store = createGmStorage(root, profile, script, digest);
    await store.save({ retained: marker, nested: { values: [true, null, 7] } });
    expect((await store.read())['retained']).toBe(marker);
    expect(await createGmStorage(root, randomUUID(), script, digest).read()).toEqual({});
    expect(await createGmStorage(root, profile, randomUUID(), digest).read()).toEqual({});
    expect(await createGmStorage(root, profile, script, scriptDigest('independent-security-integration-v2')).read()).toEqual({});
    expect((await createGmStorage(root, profile, script, digest).read())['retained']).toBe(marker);
    const file = join(root, 'gm-values', profile, script, digest + '.dpapi.json');
    const encrypted = await readFile(file);
    expect(encrypted.includes(Buffer.from(marker, 'utf8'))).toBe(false);
    expect(encrypted.includes(Buffer.from(marker, 'utf16le'))).toBe(false);
    const envelope = z.object({ protection: z.literal('windows-current-user-dpapi'), encrypted: z.string().min(1) }).parse(JSON.parse(encrypted.toString('utf8')));
    expect(envelope.encrypted.includes(marker)).toBe(false);
    passed = true;
  } finally { await record(name, passed); }
}, 120_000);

const browserTest = process.env['SWU_OCS_BROWSER'] ? test : test.skip;
const worldSchema = z.object({ id: z.number().int(), uniqueId: z.string(), name: z.string() });
type NativeWorld = z.infer<typeof worldSchema>;
const evaluationSchema = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() });
type AttachedScripts = Awaited<ReturnType<typeof attachUserScripts>>;

async function inspectPage(context: BrowserContext, page: Page): Promise<{ session: CDPSession; worlds: Map<number, NativeWorld> }> {
  const session = await context.newCDPSession(page);
  const worlds = new Map<number, NativeWorld>();
  session.on('Runtime.executionContextCreated', (raw: unknown) => {
    const event = z.object({ context: worldSchema }).parse(raw);
    worlds.set(event.context.id, event.context);
  });
  session.on('Runtime.executionContextDestroyed', (raw: unknown) => {
    const event = z.object({ executionContextId: z.number().int() }).parse(raw);
    worlds.delete(event.executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  await session.send('Runtime.enable');
  return { session, worlds };
}

async function evaluateWorld(session: CDPSession, world: NativeWorld, expression: string): Promise<unknown> {
  const raw: unknown = await session.send('Runtime.evaluate', { uniqueContextId: world.uniqueId, expression, returnByValue: true, awaitPromise: true, timeout: 5000 });
  const result = evaluationSchema.parse(raw);
  if (result.exceptionDetails !== undefined) throw new Error('The real isolated-world expression failed.');
  return result.result.value;
}

async function scriptWorld(inspector: Awaited<ReturnType<typeof inspectPage>>, name: string): Promise<NativeWorld> {
  for (const world of inspector.worlds.values()) {
    if (!world.name.startsWith('swu-gm-')) continue;
    const candidate = await evaluateWorld(inspector.session, world, 'typeof GM_info === "object" ? GM_info.script.name : null');
    if (candidate === name) return world;
  }
  throw new Error('The native isolated world for the requested script was not created.');
}

async function closeRuntimes(runtimes: { context: BrowserContext; controller: AttachedScripts | null }[]): Promise<void> {
  const outcomes = await Promise.allSettled(runtimes.map(async runtime => {
    try { await runtime.controller?.dispose(); }
    finally { await runtime.context.close({ reason: 'Independent security integration completed normally.' }); }
  }));
  const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(outcome => outcome.reason), 'Security integration normal cleanup failed; no browser was force-terminated.');
}

async function plaintextFiles(directory: string, marker: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('The isolated evidence directory unexpectedly contains a link.');
    if (entry.isDirectory()) found.push(...await plaintextFiles(path, marker));
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      if (bytes.includes(Buffer.from(marker, 'utf8')) || bytes.includes(Buffer.from(marker, 'utf16le'))) found.push(path);
    } else throw new Error('The isolated evidence directory unexpectedly contains a non-file.');
  }
  return found;
}

browserTest('Security: real isolated GM worlds resist page forgery and keep script, profile and tab identities separate', async () => {
  const name = 'real-chrome-isolated-gm-identities';
  const executable = process.env['SWU_OCS_BROWSER'];
  if (!executable) throw new Error('The real Chrome executable is required.');
  const root = join(work, 'gm-browser-store');
  const profileId = randomUUID();
  const marker = 'integration-only-' + randomUUID();
  const declarations = ['@grant GM_info', '@grant GM_getValue', '@grant GM_setValue', '@grant GM_listValues', '@run-at document-end'];
  const programA = parseUserScript(randomUUID(), scriptSource('Private A', declarations, 'document.querySelector("#a").textContent = typeof GM_getValue("retained", null) === "string" ? "stored" : "empty";'));
  const programB = parseUserScript(randomUUID(), scriptSource('Private B', declarations, 'document.querySelector("#b").textContent = GM_getValue("retained", null) === null ? "empty" : "unexpected";'));
  expect(programA.supported).toBe(true);
  expect(programB.supported).toBe(true);
  await createGmStorage(root, profileId, programA.id, programA.digest).save({ retained: marker });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response('<!doctype html><html><body><div id="a">pending</div><div id="b">pending</div><iframe id="child" src="about:blank"></iframe></body></html>', { headers: { 'Content-Type': 'text/html' } });
  } });
  const runtimes: { context: BrowserContext; controller: AttachedScripts | null }[] = [];
  let passed = false;
  try {
    const context = await chromium.launchPersistentContext(join(work, 'chrome-gm-a'), { executablePath: executable, headless: true, serviceWorkers: 'block', timeout: 30000 });
    const runtime = { context, controller: null as AttachedScripts | null };
    runtimes.push(runtime);
    runtime.controller = await attachUserScripts(context, [programA, programB], () => undefined, { root, profileId });
    const page = context.pages()[0];
    if (!page) throw new Error('The real Chrome page is missing.');
    const inspector = await inspectPage(context, page);
    const url = `http://127.0.0.1:${server.port}/identity`;
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector('#a')?.textContent === 'stored' && document.querySelector('#b')?.textContent === 'empty');
    const worldA = await scriptWorld(inspector, 'Private A');
    const worldB = await scriptWorld(inspector, 'Private B');
    expect(await evaluateWorld(inspector.session, worldA, 'GM_getValue("retained", null)')).toBe(marker);
    expect(await evaluateWorld(inspector.session, worldB, 'GM_getValue("retained", null)')).toBeNull();
    for (const expression of ['Number.NaN', 'Number.POSITIVE_INFINITY', '({ nested: undefined })', 'new Date()', '({ constructor: "reserved" })']) {
      expect(await evaluateWorld(inspector.session, worldA, `(() => { try { GM_setValue("invalid-value", ${expression}); return false; } catch { return true; } })()`)).toBe(true);
    }
    expect((await createGmStorage(root, profileId, programA.id, programA.digest).read())['invalid-value']).toBeUndefined();
    const channels = z.array(z.string()).parse(await evaluateWorld(inspector.session, worldA, 'Object.getOwnPropertyNames(globalThis).filter(key => /^__swu_gm_[a-f0-9]+$/.test(key))'));
    expect(channels).toHaveLength(1);
    const channel = channels[0];
    if (!channel) throw new Error('The genuine isolated channel is missing.');
    const forged = await page.evaluate(async ({ channel, scriptId }) => {
      const payload = JSON.stringify({ method: 'set', requestId: 1, key: 'retained', value: 'page-forgery', scriptId });
      const accessible = typeof Reflect.get(globalThis, channel) === 'function';
      window.dispatchEvent(new CustomEvent(channel, { detail: JSON.parse(payload) }));
      window.postMessage({ channel, payload, scriptId }, '*');
      document.documentElement.setAttribute('data-swu-gm-request', payload);
      Reflect.set(globalThis, channel, () => 'page-created-counterfeit');
      const counterfeit = Reflect.get(globalThis, channel);
      if (typeof counterfeit === 'function') counterfeit(payload);
      const result = { accessible, gmGetter: typeof Reflect.get(globalThis, 'GM_getValue'), nativeChannels: Object.getOwnPropertyNames(globalThis).filter(key => key.startsWith('__swu_gm_')) };
      Reflect.deleteProperty(globalThis, channel);
      return result;
    }, { channel, scriptId: programB.id });
    expect(forged.accessible).toBe(false);
    expect(forged.gmGetter).toBe('undefined');
    await runtime.controller.flush();
    expect((await createGmStorage(root, profileId, programA.id, programA.digest).read())['retained']).toBe(marker);
    expect(await evaluateWorld(inspector.session, worldB, `typeof globalThis[${JSON.stringify(channel)}]`)).toBe('undefined');
    const frameElement = await page.$('#child');
    if (!frameElement) throw new Error('The authored iframe element is missing.');
    const child = await frameElement.contentFrame();
    if (!child) throw new Error('The authored iframe document is missing.');
    expect(await child.evaluate(() => typeof Reflect.get(globalThis, 'GM_getValue'))).toBe('undefined');
    const second = await context.newPage();
    await runtime.controller.flush();
    const inspectorSecond = await inspectPage(context, second);
    await second.goto(url);
    await second.waitForFunction(() => document.querySelector('#a')?.textContent === 'stored');
    const worldSecond = await scriptWorld(inspectorSecond, 'Private A');
    expect(worldSecond.uniqueId).not.toBe(worldA.uniqueId);
    expect(await evaluateWorld(inspectorSecond.session, worldSecond, 'GM_getValue("retained", null)')).toBe(marker);
    await evaluateWorld(inspector.session, worldA, 'GM_setValue("tab-shared", "shared-by-design")');
    expect(await evaluateWorld(inspectorSecond.session, worldSecond, 'GM_getValue("tab-shared", null)')).toBe('shared-by-design');
    await second.reload();
    await second.waitForFunction(() => document.querySelector('#a')?.textContent === 'stored');
    const refreshed = await scriptWorld(inspectorSecond, 'Private A');
    expect(refreshed.uniqueId).not.toBe(worldSecond.uniqueId);
    await expect(evaluateWorld(inspectorSecond.session, worldSecond, 'GM_setValue("stale-write", "refresh-forgery")')).rejects.toThrow();
    expect((await createGmStorage(root, profileId, programA.id, programA.digest).read())['stale-write']).toBeUndefined();
    const differentProfile = randomUUID();
    const secondContext = await chromium.launchPersistentContext(join(work, 'chrome-gm-b'), { executablePath: executable, headless: true, serviceWorkers: 'block', timeout: 30000 });
    const secondRuntime = { context: secondContext, controller: null as AttachedScripts | null };
    runtimes.push(secondRuntime);
    secondRuntime.controller = await attachUserScripts(secondContext, [programA], () => undefined, { root, profileId: differentProfile });
    const otherPage = secondContext.pages()[0];
    if (!otherPage) throw new Error('The second real profile page is missing.');
    const otherInspector = await inspectPage(secondContext, otherPage);
    await otherPage.goto(url);
    await otherPage.waitForFunction(() => document.querySelector('#a')?.textContent === 'empty');
    const otherWorld = await scriptWorld(otherInspector, 'Private A');
    expect(await evaluateWorld(otherInspector.session, otherWorld, 'GM_getValue("retained", null)')).toBeNull();
    const changedProgram = parseUserScript(programA.id, programA.content + '\nvoid 0;');
    expect(changedProgram.digest).not.toBe(programA.digest);
    const changedContext = await chromium.launchPersistentContext(join(work, 'chrome-gm-changed'), { executablePath: executable, headless: true, serviceWorkers: 'block', timeout: 30000 });
    const changedRuntime = { context: changedContext, controller: null as AttachedScripts | null };
    runtimes.push(changedRuntime);
    changedRuntime.controller = await attachUserScripts(changedContext, [changedProgram], () => undefined, { root, profileId });
    const changedPage = changedContext.pages()[0];
    if (!changedPage) throw new Error('The source-change profile page is missing.');
    const changedInspector = await inspectPage(changedContext, changedPage);
    await changedPage.goto(url);
    await changedPage.waitForFunction(() => document.querySelector('#a')?.textContent === 'empty');
    const changedWorld = await scriptWorld(changedInspector, 'Private A');
    expect(await evaluateWorld(changedInspector.session, changedWorld, 'GM_getValue("retained", null)')).toBeNull();
    await page.goto(`http://127.0.0.1:${server.port}/navigated`);
    await page.waitForFunction(() => document.querySelector('#a')?.textContent === 'stored');
    await expect(evaluateWorld(inspector.session, worldA, 'GM_setValue("stale-write", "navigation-forgery")')).rejects.toThrow();
    expect((await createGmStorage(root, profileId, programA.id, programA.digest).read())['stale-write']).toBeUndefined();
    await runtime.controller.flush();
    const encrypted = await readFile(join(root, 'gm-values', profileId, programA.id, programA.digest + '.dpapi.json'));
    expect(encrypted.includes(Buffer.from(marker))).toBe(false);
    passed = true;
  } finally {
    let cleaned = false;
    try {
      await closeRuntimes(runtimes);
      if (passed) for (const folder of ['chrome-gm-a', 'chrome-gm-b', 'chrome-gm-changed']) expect(await plaintextFiles(join(work, folder), marker)).toEqual([]);
      cleaned = true;
    } finally { await server.stop(true); await record(name, passed && cleaned); }
  }
}, 120_000);

browserTest('Security: same-document navigation revokes the old isolated GM mutation authority', async () => {
  const name = 'same-document-gm-revocation';
  const executable = process.env['SWU_OCS_BROWSER'];
  if (!executable) throw new Error('The real Chrome executable is required.');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response('<!doctype html><html><body><div id="ready">pending</div></body></html>', { headers: { 'Content-Type': 'text/html' } });
  } });
  const root = join(work, 'gm-spa-store');
  const profileId = randomUUID();
  const source = scriptSource('SPA authority', ['@grant GM_info', '@grant GM_getValue', '@grant GM_setValue'], 'document.querySelector("#ready").textContent = "ready";').replace('@match http://127.0.0.1/*', '@match http://127.0.0.1/allowed');
  const program = parseUserScript(randomUUID(), source);
  const runtimes: { context: BrowserContext; controller: AttachedScripts | null }[] = [];
  let passed = false;
  try {
    const context = await chromium.launchPersistentContext(join(work, 'chrome-gm-spa'), { executablePath: executable, headless: true, serviceWorkers: 'block', timeout: 30000 });
    const runtime = { context, controller: null as AttachedScripts | null };
    runtimes.push(runtime);
    runtime.controller = await attachUserScripts(context, [program], () => undefined, { root, profileId });
    const page = context.pages()[0];
    if (!page) throw new Error('The real SPA test page is missing.');
    const inspector = await inspectPage(context, page);
    await page.goto(`http://127.0.0.1:${server.port}/allowed`);
    await page.waitForFunction(() => document.querySelector('#ready')?.textContent === 'ready');
    const world = await scriptWorld(inspector, 'SPA authority');
    await page.evaluate(() => history.pushState({}, '', '/blocked'));
    const outcome = await evaluateWorld(inspector.session, world, '(async () => { try { await GM_setValue("after-revocation", "must-not-persist"); return true; } catch { return false; } })()');
    expect(outcome).toBe(false);
    expect((await createGmStorage(root, profileId, program.id, program.digest).read())['after-revocation']).toBeUndefined();
    passed = true;
  } finally {
    let cleaned = false;
    try { await closeRuntimes(runtimes); cleaned = true; }
    finally { await server.stop(true); await record(name, passed && cleaned); }
  }
}, 120_000);

browserTest('Security: navigation cancels queued old-document GM mutations before persistence', async () => {
  const name = 'queued-document-gm-revocation';
  const executable = process.env['SWU_OCS_BROWSER'];
  if (!executable) throw new Error('The real Chrome executable is required.');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    return new Response('<!doctype html><html><body><div id="ready">pending</div></body></html>', { headers: { 'Content-Type': 'text/html' } });
  } });
  const root = join(work, 'gm-queue-store');
  const profileId = randomUUID();
  const source = scriptSource('Queued authority', ['@grant GM_info', '@grant GM_setValue'], 'document.querySelector("#ready").textContent = "ready";').replace('@match http://127.0.0.1/*', '@match http://127.0.0.1/allowed');
  const program = parseUserScript(randomUUID(), source);
  const runtimes: { context: BrowserContext; controller: AttachedScripts | null }[] = [];
  let passed = false;
  try {
    const context = await chromium.launchPersistentContext(join(work, 'chrome-gm-queue'), { executablePath: executable, headless: true, serviceWorkers: 'block', timeout: 30000 });
    const runtime = { context, controller: null as AttachedScripts | null };
    runtimes.push(runtime);
    runtime.controller = await attachUserScripts(context, [program], () => undefined, { root, profileId });
    const page = context.pages()[0];
    if (!page) throw new Error('The real queued-mutation page is missing.');
    const inspector = await inspectPage(context, page);
    await page.goto(`http://127.0.0.1:${server.port}/allowed`);
    await page.waitForFunction(() => document.querySelector('#ready')?.textContent === 'ready');
    const world = await scriptWorld(inspector, 'Queued authority');
    await evaluateWorld(inspector.session, world, '(() => { for (let index = 0; index < 8; index += 1) { void GM_setValue("queued-" + index, "old-document").catch(() => undefined); } return true; })()');
    await page.goto(`http://127.0.0.1:${server.port}/blocked`);
    await runtime.controller.flush();
    const values = await createGmStorage(root, profileId, program.id, program.digest).read();
    expect(values['queued-7']).toBeUndefined();
    passed = true;
  } finally {
    let cleaned = false;
    try { await closeRuntimes(runtimes); cleaned = true; }
    finally { await server.stop(true); await record(name, passed && cleaned); }
  }
}, 120_000);

const helperReportSchema = z.object({ responses: z.array(z.object({ status: z.number().int(), body: z.string() })) });

browserTest('Security: real managed-page helper requests remain denied with synchronization on and off', async () => {
  const name = 'anonymous-compatibility-remains-403';
  const reports: z.infer<typeof helperReportSchema>[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (new URL(request.url).pathname === '/report') {
      reports.push(helperReportSchema.parse(await request.json()));
      return new Response('OK');
    }
    return new Response(`<!doctype html><html><body><div id="authored-page">Security integration</div><script>
      window.addEventListener('load', async () => {
        const responses = [];
        for (const [path, method] of [['/browser','GET'],['/ocs-global-setting','GET'],['/get-actions-key','GET'],['/ocs-script-actions','GET'],['/ocs-script-actions','POST']]) {
          const response = await fetch('http://127.0.0.1:15319' + path, {method});
          responses.push({status: response.status, body: await response.text()});
        }
        await fetch('/report', {method:'POST', body: JSON.stringify({responses})});
      });
    </script></body></html>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  const directory = join(work, 'helpers');
  const service = createOcsService(directory);
  let passed = false;
  try {
    const marker = 'integration-only-' + randomUUID();
    for (const syncEnabled of [false, true]) {
      const initial = await service.execute({ command: 'state' });
      await service.execute({ command: 'settings-save', settings: { ...initial.settings, syncEnabled, globalConfigJson: JSON.stringify({ apiKey: marker, unfamiliarPrivateField: marker }) } });
      const before = reports.length;
      const created = await service.execute({ command: 'browser-create', browser: { ...browserMetadata, startUrl: `http://127.0.0.1:${server.port}/` } });
      const browser = created.browsers.at(-1);
      if (!browser) throw new Error('The managed integration browser is missing.');
      await service.execute({ command: 'browser-start', id: browser.id });
      const deadline = Date.now() + 10_000;
      while (reports.length === before && Date.now() < deadline) await Bun.sleep(25);
      const report = reports[before];
      if (!report) throw new Error('The real authored helper page did not report within ten seconds.');
      expect(report.responses).toHaveLength(5);
      for (const response of report.responses) {
        expect(response.status).toBe(403);
        expect(response.body.includes(marker)).toBe(false);
      }
      await service.execute({ command: 'browser-stop', id: browser.id });
    }
    const encrypted = await readFile(join(directory, 'ocs', 'source-integration', 'configuration.dpapi.json'), 'utf8');
    expect(encrypted.includes(marker)).toBe(false);
    passed = true;
  } finally {
    await service.close();
    await server.stop(true);
    await record(name, passed);
  }
}, 120_000);
