import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { z } from 'zod';
import { downloadUrl, verifiedAddresses } from '../bun/ocs-download';

export const gmRequestSchema = z.object({
  url: z.string().min(1).max(8192), method: z.enum(['GET', 'HEAD', 'POST']),
  headers: z.record(z.string().max(100), z.string().max(8192)),
  data: z.string().max(32768).nullable(), timeout: z.number().int().min(1).max(20000),
  responseType: z.enum(['text', 'json'])
}).strict();
export type GmRequest = z.infer<typeof gmRequestSchema>;
export interface GmNetworkReply { status: number; statusText: string; responseText: string; responseHeaders: string; finalUrl: string; readyState: 4 }
interface HopReply { reply: GmNetworkReply; location: string | null }
const redirects = new Set([301, 302, 303, 307, 308]);

/** Deliberately accept exact DNS names, never wildcard, self, IP or implicit subdomains. */
export function connectHost(value: string): string {
  if (value !== value.trim() || value !== value.toLowerCase() || !/^[a-z0-9.-]+$/.test(value) || value.length > 253 || value.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new TypeError('GM @connect requires a lower-case exact public DNS hostname.');
  const url = downloadUrl('https://' + value + '/');
  if (url.hostname !== value) throw new TypeError('GM @connect hostname normalization is not allowed.');
  return value;
}
export function networkUrl(value: string, hosts: readonly string[]): URL {
  const url = downloadUrl(value);
  if (!hosts.includes(url.hostname)) throw new TypeError('GM network target is not an explicitly reviewed @connect hostname.');
  return url;
}

/** Never forward ambient credentials or caller-controlled routing/framing/proxy headers. */
export function networkHeaders(headers: Record<string, string>): Record<string, string> {
  if (Object.keys(headers).length > 32 || Buffer.byteLength(JSON.stringify(headers)) > 16384) throw new RangeError('GM request headers exceed 32 fields or 16 KiB.');
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(lower) || /[\r\n\0]/.test(value) || ['host', 'cookie', 'cookie2', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect', 'accept-encoding', 'origin', 'referer', 'user-agent'].includes(lower) || /^(proxy-|sec-|x-forwarded-|forwarded$)/.test(lower)) throw new TypeError('GM request contains a forbidden routing, ambient credential or framing header.');
    if (Object.hasOwn(result, lower)) throw new TypeError('GM request contains duplicate case-insensitive headers.');
    result[lower] = value;
  }
  return result;
}

async function pinnedHop(url: URL, input: GmRequest, headers: Record<string, string>, signal: AbortSignal, verify: () => Promise<void>): Promise<HopReply> {
  signal.throwIfAborted();
  const addresses = await new Promise<Awaited<ReturnType<typeof verifiedAddresses>>>((resolve, reject) => {
    const abort = (): void => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void verifiedAddresses(url).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
  signal.throwIfAborted();
  await verify();
  signal.throwIfAborted();
  const address = addresses[0];
  if (!address) throw new TypeError('GM network request has no verified public connection address.');
  return await new Promise<HopReply>((resolve, reject) => {
    const req = request({ protocol: 'https:', hostname: address.address, family: address.family, port: 443,
      servername: url.hostname, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      rejectUnauthorized: true, agent: false, method: input.method, path: url.pathname + url.search, signal,
      maxHeaderSize: 16384, headers: { ...headers, Host: url.host, 'Accept-Encoding': 'identity' }
    }, response => {
      const status = response.statusCode;
      if (status === undefined) { req.destroy(new TypeError('GM response has no HTTP status code.')); return; }
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('GM response stream ended before completion.')));
      if (redirects.has(status)) {
        resolve({ reply: { status, statusText: '', responseText: '', responseHeaders: '', finalUrl: url.href, readyState: 4 }, location: response.headers.location ?? null });
        response.destroy(); return;
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { req.destroy(new TypeError('GM network subset requires an uncompressed response.')); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1048576) { req.destroy(new RangeError('GM response exceeds 1 MiB.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const visible = Object.entries(response.headers).filter(([name]) => !['set-cookie', 'set-cookie2', 'www-authenticate', 'proxy-authenticate'].includes(name));
        resolve({ reply: { status, statusText: response.statusMessage ?? '', responseText: Buffer.concat(chunks).toString('utf8'), responseHeaders: visible.map(([name, value]) => name + ': ' + (Array.isArray(value) ? value.join(', ') : value ?? '')).join('\r\n'), finalUrl: url.href, readyState: 4 }, location: null });
      });
    });
    req.on('error', reject);
    req.end(input.data ?? undefined);
  });
}

/** One bounded request chain; POST redirects are rejected rather than replaying side effects. */
export async function requestGmNetwork(input: GmRequest, hosts: readonly string[], signal: AbortSignal, verify: () => Promise<void>): Promise<GmNetworkReply> {
  const parsed = gmRequestSchema.parse(input);
  if (parsed.data !== null && (parsed.method !== 'POST' || Buffer.byteLength(parsed.data) > 32768)) throw new TypeError('GM request body must be a POST string of at most 32 KiB.');
  const headers = networkHeaders(parsed.headers);
  let url = networkUrl(parsed.url, hosts);
  const timeout = AbortSignal.timeout(parsed.timeout);
  const bounded = AbortSignal.any([signal, timeout]);
  for (let hop = 0; hop <= 5; hop += 1) {
    bounded.throwIfAborted();
    const result = await pinnedHop(url, parsed, headers, bounded, verify);
    bounded.throwIfAborted();
    await verify();
    if (!redirects.has(result.reply.status)) return result.reply;
    if (parsed.method === 'POST') throw new TypeError('GM POST redirects are forbidden; the original request may already have been processed.');
    if (hop === 5 || !result.location) throw new RangeError('GM redirect chain exceeds five hops or has no Location.');
    // Do not forward explicit authorization/custom secrets across origins, even within @connect.
    const target = networkUrl(new URL(result.location, url).href, hosts);
    if (target.origin !== url.origin && Object.keys(headers).some(name => !['accept', 'accept-language', 'content-type'].includes(name))) throw new TypeError('GM cross-origin redirects cannot forward caller-provided secret headers.');
    url = target;
  }
  throw new RangeError('GM redirect chain exhausted.');
}
