import { randomUUID } from 'node:crypto';
import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { z } from 'zod';
import type { ScriptProgram } from '../bun/ocs-assets';
import { createGmStorage } from '../bun/ocs-gm-storage';
import { acceptsScript } from './gm-matching';
import { parseMatchPattern, matchScriptPattern } from './script-matching';
import { installGmWorld } from './gm-world';
import { installGmNetwork } from './gm-network-world';
import { gmRequestSchema, requestGmNetwork } from './gm-network';
import { equalGmValue, gmKeySchema, gmValue, gmValues, type GmValues, type UserScriptStorageOptions, type UserScriptController } from './gm-types';

const contextSchema = z.object({ context: z.object({ id: z.number().int(), uniqueId: z.string().min(1), name: z.string(), auxData: z.object({ isDefault: z.boolean(), frameId: z.string() }) }) });
const destroyedSchema = z.object({ executionContextId: z.number().int(), executionContextUniqueId: z.string() });
const frameSchema = z.object({ id: z.string(), parentId: z.string().optional(), loaderId: z.string(), url: z.string() });
interface FrameTree { frame: z.infer<typeof frameSchema>; childFrames?: FrameTree[] }
const frameTreeSchema: z.ZodType<FrameTree> = z.lazy(() => z.object({ frame: frameSchema, childFrames: z.array(frameTreeSchema).optional() }));
const frameIdSchema = z.object({ frameId: z.string() });
const bindingSchema = z.object({ name: z.string(), executionContextId: z.number().int(), payload: z.string().max(65_536) });
const messageSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('network'), requestId: z.number().int().positive(), grant: z.enum(['GM_xmlhttpRequest', 'GM.xmlHttpRequest']), request: gmRequestSchema }),
  z.object({ method: z.literal('network-abort'), requestId: z.number().int().positive() }),
  z.object({ method: z.literal('set'), requestId: z.number().int().positive(), key: gmKeySchema, value: z.unknown() }),
  z.object({ method: z.literal('delete'), requestId: z.number().int().positive(), key: gmKeySchema }),
  z.object({ method: z.literal('tab-save'), requestId: z.number().int().positive(), value: z.unknown() }),
  z.object({ method: z.literal('tab-get'), requestId: z.number().int().positive() }),
  z.object({ method: z.literal('tabs-get'), requestId: z.number().int().positive() }),
  z.object({ method: z.literal('callback-failed') }),
  z.object({ method: z.literal('executed') }),
  z.object({ method: z.literal('failed') })
]);
type Message = z.infer<typeof messageSchema>;
interface ManagedScript { program: ScriptProgram; store: ReturnType<typeof createGmStorage>; values: GmValues; channel: string; world: string }
interface DocumentLease { id: string; parentId: string | null; loaderId: string; url: string; navigating: boolean }
interface ContextLease { id: number; uniqueId: string; script: ManagedScript; document: DocumentLease; revoked: string | null }
interface ManagedPage { page: Page; tabId: string; tabs: Map<ManagedScript, GmValues>; session: CDPSession; contexts: Map<number, ContextLease>; frames: Map<string, DocumentLease>; registrations: Map<ManagedScript, string> }
type Reporter = (id: string, outcome: 'executed' | 'failed') => void;

function aborted(cause: unknown): boolean { return cause instanceof DOMException && cause.name === 'AbortError'; }

/** Bind every accepted operation to one native context and one non-renewable document lease. */
export async function attachGmScripts(context: BrowserContext, programs: ScriptProgram[], options: UserScriptStorageOptions, report: Reporter): Promise<UserScriptController> {
  const scripts: ManagedScript[] = [];
  for (const program of programs) {
    const store = createGmStorage(options.root, options.profileId, program.id, program.digest);
    scripts.push({ program, store, values: await store.read(), channel: '__swu_gm_' + randomUUID().replaceAll('-', ''), world: 'swu-gm-' + randomUUID() });
  }
  const pages = new Set<ManagedPage>();
  const revokedContexts = new Set<string>();
  const notifications = new Set<Promise<void>>();
  const notifiedLeases = new WeakSet<ContextLease>();
  const errors: Error[] = [];
  const networkRequests = new Map<ContextLease, Map<number, AbortController>>();
  let tail = Promise.resolve();
  let pending = 0;
  let disposed = false;
  let cleanupFinished = false;
  let disposal: Promise<void> | null = null;
  function remember(cause: unknown, script: ManagedScript | null): void {
    errors.push(new Error('Isolated GM operation failed; inspect the retained cause before assuming a durable result.', { cause }));
    if (script) report(script.program.id, 'failed');
  }
  function observe(operation: Promise<void>, script: ManagedScript | null): void {
    notifications.add(operation);
    void operation.then(() => { notifications.delete(operation); }, cause => {
      notifications.delete(operation);
      if (!aborted(cause)) remember(cause, script);
    });
  }
  function enqueue(operation: () => Promise<void>): Promise<void> {
    if (disposed) return Promise.reject(new DOMException('The GM owner was disposed.', 'AbortError'));
    if (pending >= 128) return Promise.reject(new RangeError('The GM host queue exceeds 128 accepted operations.'));
    pending += 1;
    const result = tail.then(operation);
    tail = result.then(() => { pending -= 1; }, () => { pending -= 1; });
    return result;
  }
  function present(page: ManagedPage, lease: ContextLease): boolean {
    return pages.has(page) && !page.page.isClosed() && page.contexts.get(lease.id) === lease;
  }
  async function evaluateOriginal(page: ManagedPage, lease: ContextLease, expression: string): Promise<void> {
    if (!present(page, lease)) return;
    try {
      const reply = await page.session.send('Runtime.evaluate', { uniqueContextId: lease.uniqueId, expression, returnByValue: true });
      if (reply.exceptionDetails) throw new Error('The original isolated GM context could not process its acknowledgement.');
    } catch (cause) { if (present(page, lease)) throw cause; }
  }
  function revoke(page: ManagedPage, lease: ContextLease, reason: string): void {
    lease.revoked = lease.revoked ?? reason;
    revokedContexts.add(lease.uniqueId);
    for (const controller of networkRequests.get(lease)?.values() ?? []) controller.abort(new DOMException('The original GM network document lease was revoked.', 'AbortError'));
    if (notifiedLeases.has(lease)) return;
    notifiedLeases.add(lease);
    observe(evaluateOriginal(page, lease, `globalThis[${JSON.stringify(lease.script.channel + '_client')}]?.revoke(${JSON.stringify(reason + ' Writes whose durable commit already started are not rolled back.')})`), lease.script);
  }
  function revokeFrame(page: ManagedPage, frameId: string, reason: string): void {
    const affected = new Set([frameId]);
    for (const id of affected) for (const frame of page.frames.values()) if (frame.parentId === id) affected.add(frame.id);
    for (const id of affected) {
      const frame = page.frames.get(id);
      if (frame) frame.navigating = true;
      for (const lease of page.contexts.values()) if (lease.document.id === id) revoke(page, lease, reason);
    }
  }
  function assertLease(page: ManagedPage, lease: ContextLease): void {
    if (disposed || !present(page, lease) || lease.revoked !== null || page.frames.get(lease.document.id) !== lease.document || lease.document.navigating) throw new DOMException('The GM document lease was revoked before this operation could complete.', 'AbortError');
    if (!acceptsScript(lease.script.program, lease.document.url, parseMatchPattern, matchScriptPattern)) throw new DOMException('The GM document no longer matches the reviewed script scope.', 'AbortError');
  }
  async function verifyLease(page: ManagedPage, lease: ContextLease): Promise<void> {
    assertLease(page, lease);
    const reply = await page.session.send('Runtime.evaluate', { uniqueContextId: lease.uniqueId, expression: 'location.href', returnByValue: true }).catch((cause: unknown) => { assertLease(page, lease); throw cause; });
    assertLease(page, lease);
    if (reply.exceptionDetails || typeof reply.result.value !== 'string') throw new Error('The native GM document identity could not be verified.');
    if (reply.result.value !== lease.document.url || !acceptsScript(lease.script.program, reply.result.value, parseMatchPattern, matchScriptPattern)) {
      revoke(page, lease, 'The original GM document URL changed.');
      throw new DOMException('The original GM document URL changed.', 'AbortError');
    }
  }
  function source(script: ManagedScript): string {
    const { content, resources, ...metadata } = script.program;
    const seed = { channel: script.channel, grants: script.program.grants, values: script.values, name: script.program.name, version: script.program.version, resources };
    return `(() => { const metadata=${JSON.stringify(metadata)}; const parse=${parseMatchPattern.toString()}; const match=${matchScriptPattern.toString()}; const accepts=${acceptsScript.toString()}; if (!accepts(metadata,location.href,parse,match)) return; const channel=${JSON.stringify(script.channel)}; if (Object.hasOwn(globalThis,channel+'_client')) return; (${installGmWorld.toString()})(${JSON.stringify(seed)}); (${installGmNetwork.toString()})(channel,metadata.grants); const notify=method => globalThis[channel](JSON.stringify({method})); const execute=()=>{try{(()=>{\n${content}\n})();notify('executed');}catch{notify('failed');throw new Error('The imported isolated GM script failed.');}}; if(metadata.runAt==='document-start')execute();else if(metadata.runAt==='document-end'){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',execute,{once:true});else execute();}else{if(document.readyState==='complete')execute();else globalThis.addEventListener('load',execute,{once:true});} })();`;
  }
  async function register(page: ManagedPage, script: ManagedScript): Promise<void> {
    if (disposed || page.page.isClosed()) return;
    const previous = page.registrations.get(script);
    const result = await page.session.send('Page.addScriptToEvaluateOnNewDocument', { source: source(script), worldName: script.world });
    page.registrations.set(script, result.identifier);
    if (previous) await page.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous });
  }
  async function broadcast(script: ManagedScript, sender: ContextLease, name: string, previous: GmValues): Promise<void> {
    const failures: unknown[] = [];
    const changed = !equalGmValue(previous[name], script.values[name]);
    for (const page of pages) {
      try { await register(page, script); } catch (cause) { failures.push(cause); }
      for (const lease of page.contexts.values()) {
        if (lease.script !== script || lease.revoked !== null) continue;
        try {
          await verifyLease(page, lease);
          const change = changed ? { key: name, oldValue: previous[name], newValue: script.values[name], remote: lease.uniqueId !== sender.uniqueId } : null;
          await evaluateOriginal(page, lease, `globalThis[${JSON.stringify(script.channel + '_client')}]?.update(${JSON.stringify(script.values)},${JSON.stringify(change)})`);
        } catch (cause) { if (!aborted(cause)) failures.push(cause); }
      }
    }
    if (failures.length) throw new AggregateError(failures, 'GM durable commit succeeded, but isolated value-change delivery failed.');
  }
  async function network(page: ManagedPage, lease: ContextLease, input: Extract<Message, { method: 'network' }>): Promise<void> {
    const requests = networkRequests.get(lease) ?? new Map<number, AbortController>();
    const controller = new AbortController();
    let admitted = false;
    try {
      if (!lease.script.program.grants.includes(input.grant)) throw new TypeError('This exact GM network alias was not explicitly granted to the reviewed script.');
      if (requests.has(input.requestId) || requests.size >= 8 || [...networkRequests.values()].reduce((sum, entries) => sum + entries.size, 0) >= 32) throw new RangeError('GM host network limit exceeded or request identity was reused.');
      requests.set(input.requestId, controller); networkRequests.set(lease, requests); admitted = true;
      await verifyLease(page, lease);
      const reply = await requestGmNetwork(input.request, lease.script.program.connects, controller.signal, () => verifyLease(page, lease));
      await verifyLease(page, lease);
      await evaluateOriginal(page, lease, `globalThis[${JSON.stringify(lease.script.channel + '_network')}]?.complete(${input.requestId},null,'load',${JSON.stringify(reply)},${JSON.stringify(input.request.responseType)})`);
    } catch (cause) {
      const timeout = cause instanceof Error && (cause.name === 'TimeoutError' || cause.cause instanceof Error && cause.cause.name === 'TimeoutError');
      const kind = timeout ? 'timeout' : controller.signal.aborted || aborted(cause) ? 'abort' : 'error';
      const error = timeout ? 'GM HTTPS request exceeded its timeout; a submitted POST may already have been processed.' : kind === 'abort' ? 'GM HTTPS request was cancelled or its document lease was revoked; remote processing is not rolled back.' : cause instanceof TypeError || cause instanceof RangeError ? cause.message : 'GM HTTPS connection or response failed. Check the public endpoint, DNS and TLS trust; no retry was sent.';
      await evaluateOriginal(page, lease, `globalThis[${JSON.stringify(lease.script.channel + '_network')}]?.complete(${input.requestId},${JSON.stringify(error)},${JSON.stringify(kind)},null,${JSON.stringify(input.request.responseType)})`);
    } finally {
      if (admitted) { requests.delete(input.requestId); if (requests.size === 0) networkRequests.delete(lease); }
    }
  }
  async function message(page: ManagedPage, lease: ContextLease, request: Exclude<Message, { method: 'network' | 'network-abort' }>): Promise<void> {
    let committed = false;
    try {
      await verifyLease(page, lease);
      if (request.method === 'executed' || request.method === 'failed') { report(lease.script.program.id, request.method); return; }
      if (request.method === 'callback-failed') throw new Error('An isolated GM asynchronous value-change or tab callback rejected. The durable write is not rolled back.');
      const script = lease.script;
      const grants = { set: 'GM_setValue', delete: 'GM_deleteValue', 'tab-save': 'GM_saveTab', 'tab-get': 'GM_getTab', 'tabs-get': 'GM_getTabs' } as const;
      if (!script.program.grants.includes(grants[request.method])) throw new Error('The GM operation was not explicitly granted to this exact script.');
      let result: GmValues = {};
      if (request.method === 'set' || request.method === 'delete') {
        const previous = script.values;
        const next = new Map(Object.entries(previous));
        if (request.method === 'set') next.set(request.key, gmValue(request.value, 0)); else next.delete(request.key);
        const values = gmValues(Object.fromEntries(next));
        // Recheck after encryption, before staging ciphertext, and immediately before durable rename.
        await script.store.saveLeased(values, () => verifyLease(page, lease));
        script.values = values; committed = true;
        await broadcast(script, lease, request.key, previous);
      } else if (request.method === 'tab-save') {
        const values = gmValues(request.value);
        await verifyLease(page, lease);
        page.tabs.set(script, values);
      } else if (request.method === 'tab-get') result = page.tabs.get(script) ?? {};
      else result = gmValues(Object.fromEntries([...pages].filter(item => !item.page.isClosed()).map(item => [item.tabId, item.tabs.get(script) ?? {}])));
      await verifyLease(page, lease);
      await evaluateOriginal(page, lease, `globalThis[${JSON.stringify(script.channel + '_client')}].complete(${request.requestId},null,${JSON.stringify(result)})`);
    } catch (cause) {
      if (aborted(cause)) { revoke(page, lease, 'The original GM document lease was revoked.'); return; }
      remember(cause, lease.script);
      const error = committed ? 'GM durable commit succeeded, but value-change delivery failed. Check the owner runtime error.' : 'GM host operation failed; no success was acknowledged. Check the owner runtime error.';
      if ('requestId' in request) await evaluateOriginal(page, lease, `globalThis[${JSON.stringify(lease.script.channel + '_client')}]?.complete(${request.requestId},${JSON.stringify(error)},{})`);
    }
  }
  async function setup(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const session = await context.newCDPSession(page);
    const managed: ManagedPage = { page, tabId: randomUUID(), tabs: new Map(), session, contexts: new Map(), frames: new Map(), registrations: new Map() };
    pages.add(managed);
    function guarded(operation: () => void): void { try { operation(); } catch (cause) { remember(cause, null); } }
    function frameNavigated(raw: unknown): void {
      const frame = z.object({ frame: frameSchema }).parse(raw).frame;
      revokeFrame(managed, frame.id, 'The GM frame committed a different document.');
      managed.frames.set(frame.id, { id: frame.id, parentId: frame.parentId ?? null, loaderId: frame.loaderId, url: frame.url, navigating: false });
    }
    session.on('Page.frameStartedNavigating', (raw: unknown) => guarded(() => { revokeFrame(managed, frameIdSchema.parse(raw).frameId, 'The GM frame started navigation.'); }));
    session.on('Page.frameNavigated', (raw: unknown) => guarded(() => frameNavigated(raw)));
    session.on('Page.documentOpened', (raw: unknown) => guarded(() => frameNavigated(raw)));
    session.on('Page.navigatedWithinDocument', (raw: unknown) => guarded(() => {
      const event = z.object({ frameId: z.string(), url: z.string() }).parse(raw);
      const frame = managed.frames.get(event.frameId);
      if (frame) { frame.url = event.url; for (const lease of managed.contexts.values()) if (lease.document === frame) revoke(managed, lease, 'Same-document navigation revoked the original GM document lease.'); }
    }));
    session.on('Page.frameDetached', (raw: unknown) => guarded(() => {
      const id = frameIdSchema.parse(raw).frameId;
      revokeFrame(managed, id, 'The GM frame was detached.');
      managed.frames.delete(id);
    }));
    session.on('Runtime.executionContextCreated', (raw: unknown) => guarded(() => {
      const name = z.object({ context: z.object({ name: z.string() }) }).parse(raw).context.name;
      const script = scripts.find(item => item.world === name);
      if (!script) return;
      const event = contextSchema.parse(raw).context;
      if (event.auxData.isDefault) throw new Error('A GM world unexpectedly used the default execution context.');
      const previous = managed.contexts.get(event.id);
      if (previous?.uniqueId === event.uniqueId) return;
      if (previous) { managed.contexts.delete(event.id); revoke(managed, previous, 'The GM numeric context ID was replaced.'); }
      const frame = managed.frames.get(event.auxData.frameId);
      if (!frame) throw new Error('A GM context was created without a native frame/document lease.');
      const lease: ContextLease = { id: event.id, uniqueId: event.uniqueId, script, document: frame, revoked: revokedContexts.has(event.uniqueId) ? 'This native GM context was already revoked.' : frame.navigating ? 'The GM frame was already navigating.' : null };
      managed.contexts.set(event.id, lease);
      if (disposed) revoke(managed, lease, 'The GM owner stopped accepting new native worlds.');
    }));
    session.on('Runtime.executionContextDestroyed', (raw: unknown) => guarded(() => {
      const event = destroyedSchema.parse(raw);
      const lease = managed.contexts.get(event.executionContextId);
      if (lease?.uniqueId === event.executionContextUniqueId) { managed.contexts.delete(lease.id); revoke(managed, lease, 'The native GM execution context was destroyed.'); }
    }));
    session.on('Runtime.executionContextsCleared', () => {
      const leases = [...managed.contexts.values()]; managed.contexts.clear();
      for (const lease of leases) revoke(managed, lease, 'Native GM execution contexts were cleared.');
    });
    session.on('Runtime.bindingCalled', (raw: unknown) => guarded(() => {
      const identity = z.object({ name: z.string() }).parse(raw);
      if (!scripts.some(item => item.channel === identity.name)) return;
      const event = bindingSchema.parse(raw);
      const lease = managed.contexts.get(event.executionContextId);
      if (!lease || lease.script.channel !== event.name) throw new Error('GM binding identity did not match the native session/context lease.');
      if (Buffer.byteLength(event.payload) > 65_536) throw new RangeError('A native GM binding payload exceeds 64 KiB.');
      const request = messageSchema.parse(JSON.parse(event.payload));
      if (request.method === 'network-abort') { networkRequests.get(lease)?.get(request.requestId)?.abort(new DOMException('GM HTTPS request explicitly cancelled.', 'AbortError')); return; }
      try { assertLease(managed, lease); }
      catch (cause) { if (!aborted(cause)) throw cause; revoke(managed, lease, 'The GM document lease was revoked before request acceptance.'); return; }
      if (request.method === 'network') { observe(network(managed, lease, request), lease.script); return; }
      const operation = enqueue(() => message(managed, lease, request));
      void operation.catch(cause => {
        if (!aborted(cause)) remember(cause, lease.script);
        if (aborted(cause)) revoke(managed, lease, 'The GM owner stopped accepting requests.');
        else if ('requestId' in request) observe(evaluateOriginal(managed, lease, `globalThis[${JSON.stringify(lease.script.channel + '_client')}]?.complete(${request.requestId},'The GM host queue rejected this request.',{})`), lease.script);
      });
    }));
    page.once('close', () => {
      const leases = [...managed.contexts.values()]; managed.contexts.clear(); managed.tabs.clear(); pages.delete(managed);
      for (const lease of leases) revoke(managed, lease, 'The owned GM page closed.');
    });
    await session.send('Page.enable');
    const tree = frameTreeSchema.parse((await session.send('Page.getFrameTree')).frameTree);
    function seedFrames(node: FrameTree): void {
      const frame = node.frame;
      if (!managed.frames.has(frame.id)) managed.frames.set(frame.id, { id: frame.id, parentId: frame.parentId ?? null, loaderId: frame.loaderId, url: frame.url, navigating: false });
      for (const child of node.childFrames ?? []) seedFrames(child);
    }
    seedFrames(tree);
    await session.send('Runtime.enable');
    for (const script of scripts) { await session.send('Runtime.addBinding', { name: script.channel, executionContextName: script.world }); await register(managed, script); }
  }
  const onPage = (page: Page): void => { observe(enqueue(() => setup(page)), null); };
  context.on('page', onPage);
  try { for (const page of context.pages()) await enqueue(() => setup(page)); }
  catch (cause) {
    context.off('page', onPage);
    for (const page of pages) if (!page.page.isClosed()) await page.session.detach();
    throw new Error('GM isolated-world registration failed.', { cause });
  }
  async function drain(): Promise<void> {
    while (true) {
      const accepted = tail;
      await accepted; await Promise.allSettled([...notifications]);
      if (accepted === tail && notifications.size === 0) return;
    }
  }
  function throwFailures(): void {
    if (errors.length) throw new AggregateError([...errors], 'The isolated GM runtime has outstanding failures.');
  }
  /** Bound the caller's wait without pretending that native or storage work was cancelled. */
  function bounded(operation: Promise<void>, action: string): Promise<void> {
    return new Promise<void>((accept, reject) => {
      const timer = setTimeout(() => reject(new DOMException(`GM ${action} exceeded 20 seconds; cleanup is still tracked by isSettled(). Close the owned browser normally and retain the profile gate until it settles.`, 'TimeoutError')), 20_000);
      void operation.then(() => { clearTimeout(timer); accept(); }, cause => { clearTimeout(timer); reject(cause); });
    });
  }
  function flush(): Promise<void> {
    return bounded(drain().then(throwFailures), 'flush');
  }
  async function cleanup(): Promise<void> {
    await drain();
    for (const page of pages) {
      if (page.page.isClosed()) { pages.delete(page); continue; }
      let cleaned = true;
      async function attempt(operation: () => Promise<object | void>): Promise<void> {
        try { await operation(); }
        catch (cause) { cleaned = false; remember(cause, null); }
      }
      for (const identifier of page.registrations.values()) await attempt(() => page.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }));
      for (const script of scripts) await attempt(() => page.session.send('Runtime.removeBinding', { name: script.channel }));
      await attempt(() => page.session.detach());
      if (cleaned || page.page.isClosed()) { page.contexts.clear(); pages.delete(page); }
    }
    await drain();
    cleanupFinished = true;
    throwFailures();
  }
  /** Close admission synchronously; repeated calls share the same bounded cleanup result. */
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    disposed = true; context.off('page', onPage);
    for (const page of pages) for (const lease of page.contexts.values()) revoke(page, lease, 'The GM owner was disposed.');
    disposal = bounded(cleanup(), 'dispose');
    return disposal;
  }
  function isSettled(): boolean {
    return disposed && cleanupFinished && pending === 0 && notifications.size === 0 && pages.size === 0;
  }
  return { flush, dispose, isSettled };
}
