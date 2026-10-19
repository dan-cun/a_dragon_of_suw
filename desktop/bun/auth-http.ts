import { Cookie, CookieJar } from 'tough-cookie';
import { z } from 'zod';

export const IDM_ORIGIN = 'https://idm.swu.edu.cn';
export const allowedAuthHosts = new Set(['of.swu.edu.cn', 'uaaap.swu.edu.cn', 'idm.swu.edu.cn']);

export class AuthenticationError extends Error {
  constructor(message: string, cause: unknown) { super(message, { cause }); this.name = 'AuthenticationError'; }
}

export function checkedSchoolUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !allowedAuthHosts.has(url.hostname)) {
    throw new AuthenticationError('认证导航被阻止：学校 HTTPS 域名不在允许范围内。', undefined);
  }
  return url;
}

export const formSchema = z.object({ action: z.string().min(1), pageUrl: z.string().min(1), fields: z.record(z.string(), z.string()) });
export type LoginForm = z.infer<typeof formSchema>;
export const credentialsSchema = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(512), captcha: z.string().trim().regex(/^\d{4}$/) });
export type LoginCredentials = z.infer<typeof credentialsSchema>;
export const preparedAuthenticationSchema = z.object({
  idToken1: z.string().min(16).max(512).regex(/^(?:[a-f\d]{16})+$/i),
  idToken2: z.string().min(16).max(2048).regex(/^(?:[a-f\d]{16})+$/i),
  validateCode: z.string().regex(/^\d{4}$/),
});
export type PreparedAuthentication = z.infer<typeof preparedAuthenticationSchema>;
export const browserCookieSchema = z.object({
  name: z.string(), value: z.string(), domain: z.string().min(1), path: z.string(),
  secure: z.boolean(), httpOnly: z.boolean(), expires: z.number(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});
export type BrowserCookie = z.infer<typeof browserCookieSchema>;
export interface CookieAdapter {
  getCookies(): Promise<BrowserCookie[]>;
  setCookie(cookie: Cookie): Promise<void>;
  userAgent: string;
}

const authenticationErrorPhrases = [
  '用户名或密码错误',
  '账号或密码错误',
  '验证码输入不正确',
  '帐户将被锁定',
  '账户将被锁定',
] as const;

function recognizedFailureMessage(html: string): string | null {
  // Only known error containers and fixed phrases can reach logs; form values and scripts never do.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|noscript|textarea|select)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '');
  for (const opening of cleaned.matchAll(/<(div|span)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    const attributes = opening[2] || '';
    const id = /\bid\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const classes = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
    const idValue = id?.[1] || id?.[2] || id?.[3] || '';
    const classValues = (classes?.[1] || classes?.[2] || classes?.[3] || '').split(/\s+/);
    if (idValue !== 'tip' && !classValues.some(value => ['loginName_tips', 'pass_tips', 'validate_tips'].includes(value))) continue;
    if (/\bhidden(?:\s|=|$)/i.test(attributes) || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(attributes)) continue;
    const contentStart = (opening.index || 0) + opening[0].length;
    const ending = new RegExp(`<\\/${opening[1]}\\s*>`, 'i').exec(cleaned.slice(contentStart));
    if (!ending) continue;
    const text = cleaned.slice(contentStart, contentStart + ending.index)
      .replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&#(\d{1,7});|&#x([a-f\d]{1,6});/gi, (_entity: string, decimal: string | undefined, hexadecimal: string | undefined) => {
        const point = decimal ? Number(decimal) : parseInt(hexadecimal || '0', 16);
        return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
      })
      .replace(/\s+/g, '');
    const phrase = authenticationErrorPhrases.find(value => text.includes(value));
    if (phrase) return phrase;
  }
  return null;
}

async function readFailureDiagnosis(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) return '学校未返回可识别的错误说明';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        return '错误页面超过安全诊断大小上限，未读取其内容';
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const phrase = recognizedFailureMessage(new TextDecoder('utf-8').decode(bytes));
  return phrase ? `学校错误提示：${phrase}` : '学校未返回可识别的明确错误说明';
}

export async function importBrowserCookies(adapter: CookieAdapter, jar: CookieJar): Promise<void> {
  for (const cookie of await adapter.getCookies()) {
    const domain = cookie.domain.replace(/^\./, '');
    if (!allowedAuthHosts.has(domain) && domain !== 'swu.edu.cn') throw new AuthenticationError('学校认证返回了不受信任的 Cookie 范围。', undefined);
    const scoped = new Cookie({
      key: cookie.name, value: cookie.value, domain, path: cookie.path || '/',
      hostOnly: !cookie.domain.startsWith('.'), secure: cookie.secure, httpOnly: cookie.httpOnly,
      sameSite: cookie.sameSite?.toLowerCase(),
      expires: cookie.expires < 0 ? 'Infinity' : new Date(cookie.expires * 1000),
    });
    const imported = await jar.setCookie(scoped, `https://${domain}${cookie.path || '/'}`);
    if (!imported) throw new AuthenticationError('学校会话 Cookie 无效。', undefined);
  }
}

async function nodeRequest(url: string, method: 'GET' | 'POST', body: URLSearchParams | undefined, form: LoginForm, jar: CookieJar, adapter: CookieAdapter, signal: AbortSignal): Promise<Response> {
  const target = checkedSchoolUrl(url);
  if (target.origin !== IDM_ORIGIN) throw new AuthenticationError('认证请求目标必须是学校 IDM 服务。', undefined);
  let response: Response;
  try {
    // Bun's native HTTP fetch bypasses Chromium's affected IDM POST request path.
    response = await fetch(target.href, {
      method, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), body,
      headers: {
        'User-Agent': adapter.userAgent, Accept: method === 'GET' ? 'image/*' : 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9', Referer: form.pageUrl, Origin: IDM_ORIGIN,
        Cookie: await jar.getCookieString(target.href),
        ...(method === 'POST' ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
  } catch (cause) {
    throw new AuthenticationError(method === 'GET' ? '获取验证码失败：学校连接超时或中断。' : '认证提交连接中断，当前会话已作废；请重新登录。', cause);
  }
  for (const header of response.headers.getSetCookie()) {
    const cookie = await jar.setCookie(header, response.url);
    if (!cookie?.domain) throw new AuthenticationError('学校响应中的 Cookie 无效。', undefined);
    await adapter.setCookie(cookie);
  }
  return response;
}

export async function fetchCaptcha(form: LoginForm, jar: CookieJar, adapter: CookieAdapter, signal: AbortSignal): Promise<string> {
  const response = await nodeRequest(`${IDM_ORIGIN}/am/validate.code`, 'GET', undefined, form, jar, adapter, signal);
  const contentType = response.headers.get('content-type')?.split(';')[0];
  if (response.status !== 200 || !contentType || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(contentType)) {
    throw new AuthenticationError(`获取验证码失败：HTTP ${response.status}，学校未返回有效验证码图片。`, undefined);
  }
  const image = new Uint8Array(await response.arrayBuffer());
  if (image.length === 0 || image.length > 512_000) throw new AuthenticationError('验证码图片为空或超过允许大小。', undefined);
  return `data:${contentType};base64,${Buffer.from(image).toString('base64')}`;
}

export async function submitAuthentication(form: LoginForm, payload: PreparedAuthentication, jar: CookieJar, adapter: CookieAdapter, signal: AbortSignal): Promise<void> {
  const action = checkedSchoolUrl(form.action);
  if (action.origin !== IDM_ORIGIN || action.pathname !== '/am/UI/Login') throw new AuthenticationError('学校登录表单地址发生变化，无法提交认证。', undefined);
  const verified = preparedAuthenticationSchema.safeParse(payload);
  if (!verified.success) throw new AuthenticationError('学校认证加密结果结构无效，未提交认证请求。', undefined);
  const body = new URLSearchParams(form.fields);
  body.set('IDToken1', verified.data.idToken1);
  body.set('IDToken2', verified.data.idToken2);
  body.set('validateCode', verified.data.validateCode);
  const response = await nodeRequest(action.href, 'POST', body, form, jar, adapter, signal);
  const rawCode = response.headers.get('x-autherrorcode');
  const parsedCode = z.string().regex(/^-?\d{1,8}$/).safeParse(rawCode);
  const codeDescription = rawCode === null ? '缺失' : parsedCode.success ? parsedCode.data : '格式异常（值已隐藏）';
  if (![200, 302].includes(response.status) || !parsedCode.success || parsedCode.data !== '0') {
    let diagnosis: string;
    try { diagnosis = await readFailureDiagnosis(response, 128 * 1024); }
    catch (cause) {
      throw new AuthenticationError(`学校未通过认证（HTTP ${response.status}，X-AuthErrorCode=${codeDescription}），错误页面读取失败；当前会话已作废，请重新登录。`, cause);
    }
    throw new AuthenticationError(`学校未通过认证（HTTP ${response.status}，X-AuthErrorCode=${codeDescription}）；${diagnosis}。当前会话已作废，请重新登录。`, undefined);
  }
}
