import type { GmGrant, GmValue, GmValues } from './gm-types';

export interface GmWorldSeed { channel: string; grants: GmGrant[]; values: GmValues; name: string; version: string; resources: { name: string; source: string; text: string; dataUrl: string }[] }
export interface GmChange { key: string; oldValue?: GmValue; newValue?: GmValue; remote: boolean }

/** Install only explicit capabilities in a dedicated CDP isolated world. */
export function installGmWorld(seed: GmWorldSeed): void {
  const host = globalThis as typeof globalThis & Record<string, unknown>;
  if (Object.hasOwn(host, seed.channel + '_client')) return;
  let values = new Map(Object.entries(seed.values));
  let sequence = 0;
  let listenerSequence = 0;
  let revoked: string | null = null;
  const documentUrl = location.href;
  type Callback = (...args: unknown[]) => unknown;
  const listeners = new Map<number, { name: string; callback: Callback }>();
  function assertActive(): void {
    if (revoked === null && location.href !== documentUrl) client.revoke('The original GM document URL changed.');
    if (revoked !== null) throw new DOMException(revoked, 'AbortError');
  }
  const pending = new Map<number, { accept: (value: GmValues) => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function copy<T>(value: T): T { return structuredClone(value); }
  function key(value: unknown): string {
    if (typeof value !== 'string' || !value || value.length > 200 || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new TypeError('Invalid GM storage key.');
    return value;
  }
  function binding(): (payload: string) => void {
    const value = host[seed.channel];
    if (typeof value !== 'function') throw new Error('The isolated GM channel is not available.');
    return value as (payload: string) => void;
  }
  function callback(value: unknown): Callback {
    if (typeof value !== 'function') throw new TypeError('A GM callback must be a function.');
    return value as Callback;
  }
  function callbackFailed(): void { binding()(JSON.stringify({ method: 'callback-failed' })); }
  function call(method: string, name: string, value: unknown): Promise<GmValues> {
    if (revoked !== null) return Promise.reject(new DOMException(revoked, 'AbortError'));
    if (pending.size >= 32) throw new RangeError('GM world queue exceeds 32 pending operations.');
    const send = binding();
    sequence += 1;
    const requestId = sequence;
    return new Promise<GmValues>((accept, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('GM host acknowledgement exceeded 20 seconds.')); }, 20_000);
      pending.set(requestId, { accept, reject, timer });
      try {
        const payload = JSON.stringify({ method, requestId, key: name, value });
        if (new TextEncoder().encode(payload).byteLength > 65_536) throw new RangeError('A GM request exceeds 64 KiB.');
        send(payload);
      } catch (cause) {
        clearTimeout(timer); pending.delete(requestId);
        reject(cause instanceof Error ? cause : new Error('The isolated GM channel rejected a request.'));
      }
    });
  }
  const client = {
    update(snapshot: GmValues, change: GmChange | null): void {
      if (revoked !== null) return;
      values = new Map(Object.entries(snapshot));
      if (change === null) return;
      const errors: unknown[] = [];
      for (const [id, listener] of [...listeners]) {
        if (!listeners.has(id) || listener.name !== change.key) continue;
        try {
          // Never await a callback here: it may enqueue its own durable GM write.
          const result = listener.callback(change.key, copy(change.oldValue), copy(change.newValue), change.remote);
          if (result instanceof Promise) void result.catch(() => { callbackFailed(); });
        } catch (cause) { errors.push(cause); }
      }
      if (errors.length) throw new AggregateError(errors, 'GM value-change callback failed after durable commit.');
    },
    revoke(reason: unknown): void {
      if (typeof reason !== 'string' || !reason) throw new TypeError('GM revocation requires a non-empty reason.');
      revoked = revoked ?? reason;
      values.clear(); listeners.clear(); resources.clear();
      const network = host[seed.channel + '_network'];
      if (typeof network === 'object' && network !== null && 'revoke' in network && typeof network.revoke === 'function') network.revoke(revoked);
      for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new DOMException(revoked, 'AbortError')); }
      pending.clear();
    },
    complete(requestId: number, error: string | null, result: GmValues): void {
      const operation = pending.get(requestId);
      if (!operation) return;
      clearTimeout(operation.timer); pending.delete(requestId);
      if (error !== null) operation.reject(new Error(error)); else operation.accept(copy(result));
    }
  };
  Object.defineProperty(host, seed.channel + '_client', { value: Object.freeze(client) });
  globalThis.addEventListener('pagehide', () => client.revoke('The original GM page document was hidden or unloaded.'), { once: true });
  function install(name: GmGrant, value: object | Callback): void {
    if (seed.grants.includes(name)) Object.defineProperty(host, name, { value, configurable: false, writable: false });
  }
  const resources = new Map(seed.resources.map(resource => [resource.name, Object.freeze({ ...resource })]));
  function resource(name: unknown): { text: string; dataUrl: string } {
    assertActive();
    if (typeof name !== 'string') throw new TypeError('A GM resource name must be a string.');
    const result = resources.get(name);
    if (!result) throw new ReferenceError('The requested GM resource was not declared in the reviewed script.');
    return result;
  }
  install('GM_getResourceText', (name: unknown) => resource(name).text);
  install('GM_getResourceURL', (name: unknown) => resource(name).dataUrl);
  install('GM_info', Object.freeze({ script: Object.freeze({ name: seed.name, version: seed.version, grants: Object.freeze([...seed.grants]), resources: Object.freeze(seed.resources.map(resource => Object.freeze({ name: resource.name, url: resource.source }))) }), scriptHandler: 'SWU isolated GM subset', version: '2', storageWrites: 'Promise; await acknowledgement for durable commit', capabilities: Object.freeze({ grants: Object.freeze([...seed.grants]), valueChanges: seed.grants.includes('GM_addValueChangeListener') ? 'post-commit; remote means another native script context; async callback errors reported by owner flush' : false, tabs: seed.grants.some(grant => ['GM_getTab', 'GM_saveTab', 'GM_getTabs'].includes(grant)) ? 'callback or Promise snapshot reads; Promise writes; owned Page lifetime; profile/script/digest isolated' : false, styles: seed.grants.includes('GM_addStyle') ? 'explicit grant; shared document CSS' : false, network: seed.grants.some(grant => grant === 'GM_xmlhttpRequest' || grant === 'GM.xmlHttpRequest') ? 'anonymous HTTPS; exact @connect; GET/HEAD/POST; text/JSON; no cookie jar; bounded; POST never redirected or retried' : false, unsafeWindow: false, resources: seed.grants.some(grant => grant === 'GM_getResourceText' || grant === 'GM_getResourceURL') ? 'synchronous; declared names only; pinned bundled CSS or bounded inline UTF-8 data; data URLs; no network or file reads; non-renewable document lease' : false }) }));
  install('GM_getValue', (name: unknown, fallback: unknown) => { assertActive(); return values.has(key(name)) ? copy(values.get(key(name))) : copy(fallback); });
  install('GM_listValues', () => { assertActive(); return [...values.keys()]; });
  function json(value: unknown, depth: number): GmValue {
    if (depth > 12) throw new RangeError('GM value nesting exceeds 12 levels.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return Array.from(value, (item: unknown) => json(item, depth + 1));
    if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.entries(value).map(([name, item]: [string, unknown]) => [key(name), json(item, depth + 1)]));
    throw new TypeError('GM storage requires a finite JSON value.');
  }
  install('GM_setValue', (name: unknown, value: unknown) => call('set', key(name), json(value, 0)).then(() => {}));
  install('GM_deleteValue', (name: unknown) => call('delete', key(name), null).then(() => {}));
  install('GM_addValueChangeListener', (name: unknown, value: unknown) => {
    assertActive(); const entry = { name: key(name), callback: callback(value) };
    if (listeners.size >= 128) throw new RangeError('GM world exceeds 128 value-change listeners.');
    listenerSequence += 1; listeners.set(listenerSequence, entry); return listenerSequence;
  });
  install('GM_removeValueChangeListener', (id: unknown) => {
    assertActive();
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new TypeError('GM listener identity must be a positive integer.');
    listeners.delete(id);
  });
  function readTab(method: string, value: unknown): Promise<GmValues> {
    assertActive(); const receive = value === undefined ? null : callback(value);
    return call(method, '', null).then(async result => {
      // Run user callbacks outside the native acknowledgement's microtask checkpoint.
      await new Promise<void>(accept => { setTimeout(accept, 0); });
      assertActive();
      if (receive !== null) {
        try { await receive(copy(result)); }
        catch (cause) { callbackFailed(); throw new Error('GM tab callback failed.', { cause }); }
      }
      return copy(result);
    });
  }
  install('GM_getTab', (receive: unknown) => readTab('tab-get', receive));
  install('GM_getTabs', (receive: unknown) => readTab('tabs-get', receive));
  install('GM_saveTab', (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('GM_saveTab requires a JSON object.');
    return call('tab-save', '', json(value, 0)).then(() => {});
  });
  install('GM_addStyle', (css: unknown) => {
    assertActive();
    if (typeof css !== 'string' || new TextEncoder().encode(css).byteLength > 65_536) throw new TypeError('GM_addStyle requires a CSS string of at most 64 KiB.');
    const parent = document.head ?? document.documentElement;
    if (!parent) throw new Error('GM_addStyle requires a document element.');
    const style = document.createElement('style'); style.textContent = css; parent.append(style); return style;
  });
}
