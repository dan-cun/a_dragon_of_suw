import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';

export type AssetLogger = (level: 'info' | 'warning' | 'error', event: string, message: string) => void;
interface DownloadReply { status: number; location: string | undefined; content: string }
const retryStatuses = new Set([429, 502, 503, 504]);
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

function downloadTimeout(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' });
}

/** Permit only globally routable unicast addresses, excluding special-use ranges. */
export function isPublicDownloadAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const a = parts[0]; const b = parts[1]; const c = parts[2];
    if (a === undefined || b === undefined || c === undefined) return false;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6 || address.includes('.')) return false;
  const parts = address.toLowerCase().split(':');
  const first = Number.parseInt(parts[0] ?? '', 16);
  const second = Number.parseInt(parts[1] || '0', 16);
  if (!(first >= 0x2001 && first < 0x3000)) return false;
  // Fail closed on IETF assignments, documentation, 6to4 and AS112 service prefixes.
  return !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
    && first !== 0x2002 && first !== 0x3fff
    && !(first === 0x2620 && second === 0x4f && Number.parseInt(parts[2] || '0', 16) === 0x8000);
}

/** Validate every redirect target before DNS or connection, without disclosing URL credentials. */
export function downloadUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch (cause) { throw new TypeError('用户脚本 HTTPS 下载地址无效。', { cause }); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) throw new TypeError('用户脚本下载仅支持无账号信息的标准 HTTPS 地址。');
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) || !url.hostname.includes('.') || url.hostname.endsWith('.') || /\.(localhost|local|internal|home|lan)$/i.test(url.hostname)) throw new TypeError('用户脚本下载不允许本机或内网目标。');
  return url;
}

export async function verifiedAddresses(url: URL): Promise<LookupAddress[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([lookup(url.hostname, { all: true }), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(downloadTimeout('用户脚本域名解析超过 20 秒。')), 20_000); })]);
    if (!addresses.length || addresses.some(item => !isPublicDownloadAddress(item.address))) throw new TypeError('用户脚本域名解析到不允许的网络地址。');
    return addresses;
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Connect to a validated literal IP; DNS cannot run again between validation and TCP connect. */
async function pinnedRequest(url: URL, addresses: LookupAddress[]): Promise<DownloadReply> {
  const address = addresses[0];
  if (!address) throw new TypeError('用户脚本下载缺少已验证的连接地址。');
  return new Promise<DownloadReply>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const req = request({
      protocol: 'https:', hostname: address.address, family: address.family, port: 443,
      servername: url.hostname, checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      rejectUnauthorized: true, agent: false, method: 'GET', path: url.pathname + url.search,
      headers: { Host: url.host, Accept: 'application/javascript,text/javascript,text/plain', 'Accept-Encoding': 'identity' }
    }, response => {
      const status = response.statusCode;
      if (status === undefined) { req.destroy(new Error('用户脚本下载缺少 HTTP 状态码。')); return; }
      response.on('error', cause => { req.destroy(cause); reject(cause); });
      response.on('aborted', () => { const cause = Object.assign(new Error('用户脚本下载响应流提前中断。'), { code: 'ECONNRESET' }); req.destroy(cause); reject(cause); });
      if (redirectStatuses.has(status) || retryStatuses.has(status) || status < 200 || status >= 300) {
        resolve({ status, location: response.headers.location, content: '' });
        response.destroy();
        return;
      }
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding !== 'identity') { req.destroy(new TypeError('用户脚本下载不接受压缩响应，请提供普通源码直链。')); return; }
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 524_288) { req.destroy(new RangeError('用户脚本下载超过 512 KiB。')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status, location: undefined, content: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(downloadTimeout('用户脚本 HTTPS 下载超过 20 秒。')), 20_000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}

function transientError(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
    && ['EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE'].includes(cause.code);
}

export async function downloadScript(value: string, log: AssetLogger): Promise<{ content: string; source: string }> {
  let url = downloadUrl(value);
  for (let hop = 0; hop <= 5; hop += 1) {
    let reply: DownloadReply | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        reply = await pinnedRequest(url, await verifiedAddresses(url));
        if (!retryStatuses.has(reply.status) || attempt === 2) break;
      } catch (cause) {
        if (attempt === 2 || !transientError(cause)) throw cause;
      }
      log('warning', 'script.download.retry', 'HTTPS 暂时故障，正在进行有上限的只读重试。');
      await Bun.sleep(500 * (attempt + 1));
    }
    if (!reply) throw new Error('用户脚本 HTTPS 下载重试耗尽。');
    if (redirectStatuses.has(reply.status)) {
      if (hop === 5) throw new RangeError('用户脚本 HTTPS 下载重定向超过 5 次。');
      if (!reply.location) throw new TypeError('用户脚本 HTTPS 重定向缺少 Location。');
      let target: URL;
      try { target = new URL(reply.location, url); }
      catch (cause) { throw new TypeError('用户脚本 HTTPS 重定向地址无效。', { cause }); }
      url = downloadUrl(target.href);
      continue;
    }
    if (reply.status < 200 || reply.status >= 300) throw new Error(`用户脚本下载失败（HTTP ${reply.status}）。`);
    return { content: reply.content, source: url.origin + url.pathname };
  }
  throw new RangeError('用户脚本 HTTPS 下载重定向次数耗尽。');
}
