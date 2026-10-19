import { constants, createHash, createPrivateKey, privateDecrypt, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { readAcademicResponse } from './academic-transport';

const origin = 'https://ywtb.swu.edu.cn';
const base = '/business-center-front/';
const envelopeSchema = z.object({ code: z.union([z.string(), z.number()]), content: z.unknown() });
const signedResponseSchema = z.object({ status: z.number().int(), body: z.unknown() });
type Evaluate = (expression: string) => Promise<unknown>;

function checkedPortalResource(value: string): string {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password) throw new Error('门户资源地址不在学校 HTTPS 站点内，已停止读取。');
  return url.href;
}

async function request(evaluate: Evaluate, path: string, token: string, secret: string | null, values: Record<string, string>): Promise<unknown> {
  const params: Record<string, string> = { ...values, clientCategory: 'PC', appCode: 'new-office-hall-pc', appKey: 'pc-officeHall', universityId: '106350' };
  const url = origin + base + path + '?' + new URLSearchParams(params).toString();
  const response = await readAcademicResponse(async () => {
    const timestamp = String(Date.now());
    const nonce = randomUUID();
    const source = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&') + `&timestamp=${timestamp}&nonce=${nonce}&appSecret=${secret}`;
    const sign = createHash('md5').update(source).digest('hex').toUpperCase();
    return signedResponseSchema.parse(await evaluate(`(async () => {
    if(location.origin !== ${JSON.stringify(origin)}) throw new Error('Not the school portal');
    const response = await fetch(${JSON.stringify(url)}, {credentials:'same-origin',cache:'no-store',headers:${JSON.stringify({ business_center_token: token, timestamp, nonce, sign, Accept: 'application/json' })},signal:AbortSignal.timeout(20000)});
    const text = await response.text();
    if(text.length > 4000000) throw new Error('Portal response too large');
    let body = null; try { body = JSON.parse(text); } catch { }
    return {status:response.status,body};
  })()`));
  }, 'portal');
  if (response.status !== 200) throw new Error(`学校门户入口查询失败（HTTP ${response.status}）。请重新检查学校登录。`);
  const envelope = envelopeSchema.safeParse(response.body);
  if (!envelope.success) throw new Error('学校门户未返回有效的入口查询数据，请重新登录学校门户。');
  if (envelope.data.code !== '40001' && envelope.data.code !== 200) throw new Error(`学校门户拒绝入口查询（业务码 ${String(envelope.data.code).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 30)}）。请重新登录学校门户。`);
  return envelope.data.content;
}

function readPublicClientKey(source: string): ReturnType<typeof createPrivateKey> | null {
  const candidates = source.matchAll(/["'`]([A-Za-z0-9+/=\\nr \t-]{400,10000})["'`]/g);
  let count = 0;
  for (const match of candidates) {
    if (++count > 100) break;
    const value = match[1];
    if (!value) continue;
    const decoded = value.replace(/\\r/g, '\r').replace(/\\n/g, '\n').trim();
    const pem = decoded.includes('-----BEGIN') ? decoded : `-----BEGIN RSA PRIVATE KEY-----\n${decoded}\n-----END RSA PRIVATE KEY-----`;
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType === 'rsa') return key;
    } catch (cause) {
      if (!(cause instanceof Error)) throw cause;
    }
  }
  return null;
}

async function clientKey(evaluate: Evaluate): Promise<ReturnType<typeof createPrivateKey>> {
  const sources = z.array(z.string().url()).max(30).parse(await evaluate(`[...document.querySelectorAll('script[type="module"][src]')].map(script => script.src)`));
  for (const resource of sources) {
    const url = checkedPortalResource(resource);
    const response = await readAcademicResponse(async () => z.object({ status: z.number(), text: z.string().max(8000000) }).parse(await evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(url)}, {credentials:'same-origin',signal:AbortSignal.timeout(20000)});
      return {status:response.status,text:await response.text()};
    })()`)), 'portal-resource');
    if (response.status !== 200) throw new Error(`读取学校门户公开客户端资源失败（HTTP ${response.status}）。`);
    const key = readPublicClientKey(response.text);
    if (key) return key;
  }
  throw new Error('学校门户客户端签名格式已变化，无法自动获取教务入口。请在学校门户手动进入教务系统后重新检测。');
}

export async function teachingEntry(evaluate: Evaluate, token: string): Promise<string> {
  const encrypted = z.string().min(32).max(2000).parse(await request(evaluate, 'dynamicInterface/query', token, null, {}));
  const key = await clientKey(evaluate);
  const block = privateDecrypt({ key, padding: constants.RSA_NO_PADDING }, Buffer.from(encrypted, 'base64'));
  const separator = block.indexOf(0, 2);
  if (block[0] !== 0 || block[1] !== 2 || separator < 10) throw new Error('学校门户公开客户端签名凭据格式无效，已停止自动获取入口。');
  const secret = block.subarray(separator + 1).toString('utf8');
  if (!secret || secret.length > 512) throw new Error('学校门户签名凭据长度无效，已停止查询。');
  const groups = z.object({ list: z.array(z.object({ list: z.array(z.object({ applicationCode: z.string().min(1), applicationName: z.string() })).max(1000) })).max(100) }).parse(await request(evaluate, 'cApplication/selApplication', token, secret, { pageNum: '1', pageSize: '1000', applicationTypeEnum: 'APPLICATION' }));
  const candidates = [...new Map(groups.list.flatMap(group => group.list).filter(application => application.applicationName === '教务系统').map(application => [application.applicationCode, application])).values()];
  if (candidates.length !== 1) throw new Error('学校门户未返回唯一的“教务系统”入口，请在官方门户手动选择后重新检测。');
  const application = candidates[0];
  if (!application) throw new Error('学校门户没有可用的教务入口。');
  const resolved = z.object({ redirectUrl: z.string().url() }).parse(await request(evaluate, 'cApplication/getApplicationUrl', token, secret, { applicationCode: application.applicationCode }));
  const url = new URL(resolved.redirectUrl);
  if (!['jw.swu.edu.cn', 'ywtb.swu.edu.cn', 'uaaap.swu.edu.cn', 'idm.swu.edu.cn', 'i.swu.edu.cn'].includes(url.hostname) || url.port || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) throw new Error('门户返回的教务跳转地址不在已核实的学校站点内，已停止自动跳转。');
  url.protocol = 'https:';
  return url.href;
}
