import type { GmGrant } from './gm-types';
import type { GmNetworkReply, GmRequest } from './gm-network';

/** Install callback and Promise forms without exposing either ungranted alias. */
export function installGmNetwork(channel: string, grants: GmGrant[]): void {
  if (!grants.includes('GM_xmlhttpRequest') && !grants.includes('GM.xmlHttpRequest')) return;
  const host = globalThis as typeof globalThis & Record<string, unknown>;
  const sendValue = host[channel];
  if (typeof sendValue !== 'function') throw new TypeError('GM network native binding is unavailable.');
  const send = sendValue as (payload: string) => void;
  type Callback = (value: object) => unknown;
  interface Pending { accept: (value: object) => void; reject: (cause: Error) => void; callbacks: Map<string, Callback>; timer: ReturnType<typeof setTimeout> }
  const pending = new Map<number, Pending>();
  let sequence = 0; let revoked: string | null = null;
  const documentUrl = location.href;
  function emit(entry: Pending, name: string, value: object): void {
    const cb = entry.callbacks.get(name);
    if (!cb) return;
    try { const result = cb(value); if (result instanceof Promise) void result.catch(() => send(JSON.stringify({ method: 'callback-failed' }))); }
    catch { send(JSON.stringify({ method: 'callback-failed' })); }
  }
  function finish(requestId: number, error: string | null, kind: string, reply: GmNetworkReply | null): void {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId); clearTimeout(entry.timer);
    const result = reply === null ? { status: 0, readyState: 4, error: error ?? 'GM request failed.' } : { ...reply, response: reply.responseText };
    if (error === null) { emit(entry, 'onload', result); entry.accept(result); }
    else { emit(entry, kind === 'timeout' ? 'ontimeout' : kind === 'abort' ? 'onabort' : 'onerror', result); entry.reject(new DOMException(error, kind === 'timeout' ? 'TimeoutError' : kind === 'abort' ? 'AbortError' : 'NetworkError')); }
    emit(entry, 'onloadend', result);
  }
  const client = Object.freeze({
    complete(requestId: number, error: string | null, kind: string, reply: GmNetworkReply | null, responseType: string): void {
      if (reply !== null && error === null && responseType === 'json') {
        const entry = pending.get(requestId);
        if (!entry) return;
        let response: unknown;
        try { response = JSON.parse(reply.responseText); }
        catch { finish(requestId, 'GM JSON response is not valid JSON.', 'error', null); return; }
        pending.delete(requestId); clearTimeout(entry.timer);
        const result = { ...reply, response };
        emit(entry, 'onload', result); entry.accept(result); emit(entry, 'onloadend', result); return;
      }
      finish(requestId, error, kind, reply);
    },
    revoke(reason: string): void {
      revoked = revoked ?? reason;
      for (const id of [...pending.keys()]) { send(JSON.stringify({ method: 'network-abort', requestId: id })); finish(id, revoked, 'abort', null); }
    }
  });
  Object.defineProperty(host, channel + '_network', { value: client });
  function start(value: unknown, grant: 'GM_xmlhttpRequest' | 'GM.xmlHttpRequest'): { promise: Promise<object>; abort: () => void } {
    if (revoked !== null || location.href !== documentUrl) throw new DOMException('The original GM network document lease is no longer active.', 'AbortError');
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('GM network options must be an object.');
    const options = value as Record<string, unknown>;
    const allowed = ['url', 'method', 'headers', 'data', 'timeout', 'responseType', 'anonymous', 'onload', 'onerror', 'onabort', 'ontimeout', 'onloadend'];
    if (Object.keys(options).some(name => !allowed.includes(name))) throw new TypeError('GM network option is not supported by this bounded HTTPS subset.');
    if (options['anonymous'] !== undefined && options['anonymous'] !== true) throw new TypeError('GM network requests are always anonymous; cookie credentials are unsupported.');
    if (typeof options['url'] !== 'string' || options['url'].length > 8192) throw new TypeError('GM network URL must be a string of at most 8192 characters.');
    const method = options['method'] === undefined ? 'GET' : typeof options['method'] === 'string' ? options['method'].toUpperCase() : '';
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') throw new TypeError('GM network supports only GET, HEAD and POST.');
    const responseType = options['responseType'] === undefined || options['responseType'] === '' ? 'text' : options['responseType'];
    if (responseType !== 'text' && responseType !== 'json') throw new TypeError('GM network supports only text and JSON responses.');
    const timeout = options['timeout'] === undefined ? 20000 : options['timeout'];
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 20000) throw new TypeError('GM timeout must be an integer from 1 to 20000 milliseconds.');
    const body = options['data'] === undefined ? null : options['data'];
    if (body !== null && (typeof body !== 'string' || method !== 'POST' || new TextEncoder().encode(body).byteLength > 32768)) throw new TypeError('GM request body must be a POST string of at most 32 KiB.');
    const rawHeaders = options['headers'] === undefined ? {} : options['headers'];
    if (typeof rawHeaders !== 'object' || rawHeaders === null || Array.isArray(rawHeaders)) throw new TypeError('GM request headers must be a string map.');
    const headers: Record<string, string> = {};
    for (const [name, item] of Object.entries(rawHeaders)) { if (typeof item !== 'string') throw new TypeError('GM header values must be strings.'); headers[name] = item; }
    const callbacks = new Map<string, Callback>();
    for (const name of ['onload', 'onerror', 'onabort', 'ontimeout', 'onloadend']) {
      const cb = options[name];
      if (cb !== undefined) { if (typeof cb !== 'function') throw new TypeError('GM network callbacks must be functions.'); callbacks.set(name, cb as Callback); }
    }
    if (pending.size >= 8) throw new RangeError('GM world exceeds eight concurrent network requests.');
    sequence += 1; const requestId = sequence;
    const request: GmRequest = { url: options['url'], method, headers, data: body, timeout, responseType };
    const payload = JSON.stringify({ method: 'network', requestId, grant, request });
    if (new TextEncoder().encode(payload).byteLength > 65536) throw new RangeError('GM network request exceeds 64 KiB.');
    const promise = new Promise<object>((accept, reject) => {
      const timer = setTimeout(() => { send(JSON.stringify({ method: 'network-abort', requestId })); finish(requestId, 'GM network host settlement exceeded its bounded deadline.', 'timeout', null); }, 25000);
      pending.set(requestId, { accept, reject, callbacks, timer });
      try { send(payload); } catch (cause) { clearTimeout(timer); pending.delete(requestId); reject(cause instanceof Error ? cause : new Error('GM network native binding rejected the request.')); }
    });
    const abort = (): void => { if (pending.has(requestId)) send(JSON.stringify({ method: 'network-abort', requestId })); };
    return { promise, abort };
  }
  if (grants.includes('GM_xmlhttpRequest')) Object.defineProperty(host, 'GM_xmlhttpRequest', { value: (value: unknown) => { const operation = start(value, 'GM_xmlhttpRequest'); void operation.promise.catch(() => {}); return Object.freeze({ abort: operation.abort }); } });
  if (grants.includes('GM.xmlHttpRequest')) Object.defineProperty(host, 'GM', { value: Object.freeze({ xmlHttpRequest: (value: unknown) => { const operation = start(value, 'GM.xmlHttpRequest'); return Object.assign(operation.promise, { abort: operation.abort }); } }) });
}
