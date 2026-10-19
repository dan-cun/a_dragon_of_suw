import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { CookieJar, type Cookie } from 'tough-cookie';
import { z } from 'zod';
import { connectCdp, type CdpConnection } from './cdp';
import {
  AuthenticationError, allowedAuthHosts, browserCookieSchema, checkedSchoolUrl, credentialsSchema,
  fetchCaptcha, formSchema, importBrowserCookies, preparedAuthenticationSchema, submitAuthentication,
  type CookieAdapter, type LoginCredentials, type LoginForm, type BrowserCookie,
} from './auth-http';

export interface LoginView { stage: 'preparing' | 'ready' | 'submitting'; message: string; captcha: string; captchaCode: string }
interface ReportEntry { level: 'info' | 'warning' | 'error'; event: string; message: string }
export interface Authentication {
  start(): Promise<void>;
  submit(payload: LoginCredentials): Promise<void>;
  refresh(): Promise<void>;
  cancel(): Promise<void>;
  wait(): Promise<string>;
  getView(): LoginView;
  getCookies(): BrowserCookie[];
}

const application = new URL('https://of.swu.edu.cn/#/casLogin');
application.hash = `/casLogin?from=${encodeURIComponent('/appCenter')}`;
const callback = new URL('https://of.swu.edu.cn/gateway/fighter-middle/api/integrate/uaap/cas/resolve-cas-return');
callback.searchParams.set('next', application.href);
const initial = new URL('https://of.swu.edu.cn/cas/login');
initial.searchParams.set('service', callback.href);
const federal = new URL('https://of.swu.edu.cn/cas/oauth/login/SWU_CAS2_FEDERAL');
federal.searchParams.set('service', callback.href);

const runtimeSchema = z.object({ result: z.object({ value: z.unknown().optional() }), exceptionDetails: z.unknown().optional() });
const responseSchema = z.object({ requestId: z.string(), type: z.string().optional(), response: z.object({ url: z.url(), status: z.number(), headers: z.record(z.string(), z.union([z.string(), z.number()])) }) });
const finishedSchema = z.object({ requestId: z.string() });
const pausedSchema = z.object({ requestId: z.string(), resourceType: z.string(), request: z.object({ url: z.string(), method: z.string() }) });
const frameTreeSchema = z.object({ frameTree: z.object({ frame: z.object({ id: z.string(), url: z.string(), loaderId: z.string() }) }) });
const lifecycleSchema = z.object({ frameId: z.string(), loaderId: z.string(), name: z.string() });
const tokenSchema = z.string().min(1).max(16_384).refine(value => !/[\r\n\0]/.test(value));
const tokenBodySchema = z.object({ code: z.literal(200), data: tokenSchema });
type Outcome = { ok: true; token: string } | { ok: false; error: AuthenticationError };

function safeFailure(cause: unknown): AuthenticationError {
  return cause instanceof AuthenticationError ? cause : new AuthenticationError('校园认证未完成，请检查网络与学校服务后重新登录。', cause);
}

async function pause(signal: AbortSignal, duration: number): Promise<void> {
  if (signal.aborted) throw safeFailure(signal.reason);
  await new Promise<void>((resolvePause, reject) => {
    const abort = () => { clearTimeout(timer); reject(safeFailure(signal.reason)); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolvePause(); }, duration);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function until(predicate: () => Promise<boolean>, signal: AbortSignal, timeout: number, message: string): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    if (signal.aborted) throw safeFailure(signal.reason);
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new AuthenticationError(message, undefined);
    await pause(signal, 150);
  }
}

async function reserveDebugPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new AuthenticationError('无法分配本机 Edge 调试端口。', undefined);
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function debuggerEndpoint(port: number, signal: AbortSignal, report: (entry: ReportEntry) => void): Promise<string> {
  const deadline = Date.now() + 20_000;
  let warned = false;
  while (true) {
    if (signal.aborted) throw safeFailure(signal.reason);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]) });
      if (response.status !== 200) throw new AuthenticationError(`本机 Edge 调试服务返回 HTTP ${response.status}。`, undefined);
      return z.object({ webSocketDebuggerUrl: z.url() }).parse(await response.json() as unknown).webSocketDebuggerUrl;
    } catch (cause) {
      const code = z.object({ code: z.string() }).safeParse(cause);
      if (!code.success || !['ECONNREFUSED', 'ConnectionRefused'].includes(code.data.code)) throw safeFailure(cause);
      if (Date.now() >= deadline) throw new AuthenticationError('Edge 调试服务未在 20 秒内启动。', cause);
      if (!warned) { report({ level: 'info', event: 'auth-edge-starting', message: '正在等待系统 Edge 认证窗口就绪。' }); warned = true; }
      await pause(signal, 150);
    }
  }
}

export function createAuthentication(edgePath: string, profileRoot: string, savedCookies: BrowserCookie[], recognizeCaptcha: (imageDataUrl: string, signal: AbortSignal) => Promise<string>, report: (entry: ReportEntry) => void, onView: (view: LoginView) => void): Authentication {
  if (!isAbsolute(edgePath) || !existsSync(edgePath)) throw new AuthenticationError('未找到可用的系统 Microsoft Edge。', undefined);
  if (!isAbsolute(profileRoot)) throw new AuthenticationError('认证临时目录必须使用绝对路径。', undefined);
  const root = resolve(profileRoot);
  const controller = new AbortController();
  const jar = new CookieJar(undefined, { prefixSecurity: 'strict' });
  let view: LoginView = { stage: 'preparing', message: '正在连接学校认证服务…', captcha: '', captchaCode: '' };
  let browser: ChildProcess | null = null;
  let browserExited = false;
  let browserExit: Promise<void> | null = null;
  let profile: string | null = null;
  let profileAllocation: Promise<string> | null = null;
  let cdp: CdpConnection | null = null;
  let connectionOperation: Promise<CdpConnection> | null = null;
  let pageSession: string | null = null;
  let adapter: CookieAdapter | null = null;
  let form: LoginForm | null = null;
  let token: string | null = null;
  let sessionCookies: BrowserCookie[] = [];
  let started = false;
  let submitted = false;
  let refreshing = false;
  let finishing: Promise<void> | null = null;
  let outcome: Outcome | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let removeEvents: (() => void) | null = null;
  const tokenRequests = new Set<string>();
  const loadedDocuments = new Set<string>();
  let documentLastChanged = Date.now();
  const waiters = new Set<{ resolve: (token: string) => void; reject: (error: AuthenticationError) => void }>();
  const httpOperations = new Set<Promise<unknown>>();
  const assertActive = () => { if (controller.signal.aborted) throw safeFailure(controller.signal.reason); };
  const runHttp = <T>(operation: () => Promise<T>): Promise<T> => {
    assertActive();
    const pending = operation();
    httpOperations.add(pending);
    void pending.then(() => httpOperations.delete(pending), () => httpOperations.delete(pending));
    return pending;
  };
  const update = (next: LoginView) => { view = next; onView({ ...next }); };
  const fillCaptcha = async (image: string): Promise<string> => {
    try { return await recognizeCaptcha(image, controller.signal); }
    catch (cause) {
      assertActive();
      const reason = cause instanceof Error ? cause.message : '未知错误';
      report({ level: 'warning', event: 'auth-captcha-ocr-failed', message: `验证码自动识别失败：${reason}。请手动输入。` });
      return '';
    }
  };
  const send = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    assertActive();
    if (!cdp || !pageSession) throw new AuthenticationError('Edge 认证连接尚未就绪。', undefined);
    return cdp.send(method, params, pageSession);
  };
  const evaluate = async (expression: string): Promise<unknown> => {
    const result = runtimeSchema.parse(await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }));
    if (result.exceptionDetails !== undefined) throw new AuthenticationError('学校认证页面无法执行 SSO 操作。', undefined);
    return result.result.value;
  };
  const currentUrl = async (): Promise<URL | null> => {
    const value = frameTreeSchema.parse(await send('Page.getFrameTree', {})).frameTree.frame.url;
    return value === 'about:blank' ? null : checkedSchoolUrl(value);
  };
  const cleanup = async () => {
    controller.abort(new AuthenticationError('认证会话已结束。', undefined));
    if (timeout) clearTimeout(timeout);
    if (profileAllocation) profile = await profileAllocation;
    if (connectionOperation) {
      const connection = await Promise.allSettled([connectionOperation]);
      if (connection[0]?.status === 'fulfilled') cdp = connection[0].value;
    }
    await Promise.allSettled([...httpOperations]);
    removeEvents?.();
    try { await cdp?.requestBrowserClose(); }
    finally { cdp?.close(); }
    if (browserExit && !browserExited) {
      await Promise.race([browserExit, new Promise<void>(resolveWait => setTimeout(resolveWait, 4_000))]);
      if (!browserExited && browser) {
        report({ level: 'warning', event: 'auth-browser-stop', message: '认证窗口未及时退出，正在结束本次独立 Edge 进程。' });
        browser.kill();
        await Promise.race([browserExit, new Promise<void>(resolveWait => setTimeout(resolveWait, 4_000))]);
      }
      if (!browserExited) throw new AuthenticationError('无法结束认证 Edge 进程，请关闭应用后重新启动。', undefined);
    }
    await jar.removeAllCookies();
    if (profile) {
      const candidate = resolve(profile);
      const contained = relative(root, candidate);
      if (!contained || contained.startsWith('..') || isAbsolute(contained) || !basename(candidate).startsWith('auth-')) {
        throw new AuthenticationError('认证临时目录清理范围无效。', undefined);
      }
      await rm(candidate, { recursive: true, force: false });
    }
    cdp = null; pageSession = null; adapter = null; form = null;
    tokenRequests.clear();
    loadedDocuments.clear();
  };
  const finish = (result: Outcome): Promise<void> => {
    if (finishing) return finishing;
    finishing = (async () => {
      let finalResult = result;
      if (!result.ok) {
        update({ stage: 'preparing', message: result.error.message, captcha: '', captchaCode: '' });
        report({ level: 'warning', event: 'auth-failed', message: result.error.message });
      }
      try { if (result.ok && adapter !== null) sessionCookies = await adapter.getCookies(); }
      catch (cause) { finalResult = { ok: false, error: new AuthenticationError('学校会话读取失败，未保存记住登录信息。', cause) }; }
      try { await cleanup(); }
      catch (cause) {
        const error = new AuthenticationError('认证临时会话清理失败，请关闭应用后重新启动。', cause);
        report({ level: 'error', event: 'auth-cleanup-failed', message: error.message });
        finalResult = { ok: false, error };
      }
      outcome = finalResult;
      for (const waiter of waiters) {
        if (finalResult.ok) waiter.resolve(finalResult.token);
        else waiter.reject(finalResult.error);
      }
      waiters.clear();
    })();
    return finishing;
  };
  const fail = (cause: unknown) => { void finish({ ok: false, error: safeFailure(cause) }); };
  const collectBody = async (requestId: string) => {
    const result = z.object({ body: z.string(), base64Encoded: z.boolean() }).parse(await send('Network.getResponseBody', { requestId }));
    const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
    const parsed = tokenBodySchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) throw new AuthenticationError('学校应用令牌交换返回了无效数据。', undefined);
    token = parsed.data.data;
  };
  const progressSso = async (): Promise<'form' | 'application'> => {
    const navigationAttempts = 3;
    const navigate = async (url: string) => {
      const target = checkedSchoolUrl(url);
      for (let attempt = 1; ; attempt += 1) {
        const previousLoader = frameTreeSchema.parse(await send('Page.getFrameTree', {})).frameTree.frame.loaderId;
        const navigated = z.object({ errorText: z.string().optional() }).parse(await send('Page.navigate', { url: target.href }));
        if (!navigated.errorText) {
          await until(async () => {
            const frame = frameTreeSchema.parse(await send('Page.getFrameTree', {})).frameTree.frame;
            if (frame.url === 'about:blank') return false;
            checkedSchoolUrl(frame.url);
            return frame.loaderId !== previousLoader && loadedDocuments.has(frame.loaderId) && Date.now() - documentLastChanged >= 1_500;
          }, controller.signal, 30_000, '学校 SSO 页面加载超过 30 秒。');
          return;
        }
        if (attempt >= navigationAttempts) {
          report({ level: 'warning', event: 'auth-navigation-failed', message: `学校认证页面 ${target.hostname}${target.pathname} 连续 ${attempt} 次加载失败：${navigated.errorText}。` });
          throw new AuthenticationError(`学校 SSO 页面加载失败（${target.hostname}${target.pathname}：${navigated.errorText}），请检查网络与代理后重新登录。`, undefined);
        }
        report({ level: 'warning', event: 'auth-navigation-retry', message: `学校认证页面 ${target.hostname}${target.pathname} 第 ${attempt} 次加载失败：${navigated.errorText}，正在重试。` });
        await pause(controller.signal, 1_000);
      }
    };
    await navigate(initial.href);
    if (token) return 'application';
    await navigate(federal.href);
    await until(async () => {
      const current = await currentUrl();
      return token !== null || current?.hostname === 'uaaap.swu.edu.cn' || current?.hostname === 'idm.swu.edu.cn' || (current?.hostname === 'of.swu.edu.cn' && !current.pathname.startsWith('/cas/'));
    }, controller.signal, 30_000, '学校 SSO 未到达认证服务。');
    if (token) return 'application';
    const current = await currentUrl();
    if (current?.hostname === 'uaaap.swu.edu.cn') {
      await until(async () => {
        const url = await currentUrl();
        return url?.hostname !== 'uaaap.swu.edu.cn' || z.boolean().parse(await evaluate("typeof _goLogin === 'function'"));
      }, controller.signal, 20_000, '学校联邦认证页面未提供统一认证入口，可能仍处于网页验证阶段。');
      if ((await currentUrl())?.hostname !== 'uaaap.swu.edu.cn') return (await currentUrl())?.hostname === 'idm.swu.edu.cn' ? 'form' : 'application';
      const triggered = z.boolean().parse(await evaluate("(() => { if (typeof _goLogin !== 'function') return false; _goLogin(); return true; })()"));
      if (!triggered) throw new AuthenticationError('学校统一认证入口尚未准备好，请重新登录。', undefined);
    }
    await until(async () => {
      const url = await currentUrl();
      return token !== null || (url?.hostname === 'idm.swu.edu.cn' && url.pathname === '/am/UI/Login') || (url?.hostname === 'of.swu.edu.cn' && !url.pathname.startsWith('/cas/'));
    }, controller.signal, 60_000, '学校未返回 IDM 登录表单。');
    return (await currentUrl())?.hostname === 'idm.swu.edu.cn' ? 'form' : 'application';
  };
  return {
    getView: () => ({ ...view }),
    wait() {
      if (outcome) return outcome.ok ? Promise.resolve(outcome.token) : Promise.reject(outcome.error);
      return new Promise<string>((resolveToken, reject) => { waiters.add({ resolve: resolveToken, reject }); });
    },
    async start() {
      if (started) throw new AuthenticationError('当前认证已启动。', undefined);
      started = true;
      timeout = setTimeout(() => fail(new AuthenticationError('校园登录超过 5 分钟，请重新登录。', undefined)), 300_000);
      try {
        await mkdir(root, { recursive: true });
        assertActive();
        profileAllocation = mkdtemp(join(root, 'auth-'));
        profile = await profileAllocation;
        assertActive();
        const debugPort = await reserveDebugPort();
        assertActive();
        browser = spawn(edgePath, [
          `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
          '--no-first-run', '--no-default-browser-check', '--disable-extensions',
          '--edge-skip-compat-layer-relaunch', '--disable-background-mode',
          '--window-position=-32000,-32000', '--window-size=1000,720', 'about:blank',
        ], { windowsHide: true, stdio: 'ignore' });
        browserExit = new Promise<void>(resolveExit => { browser?.once('close', () => { browserExited = true; resolveExit(); if (!finishing) fail(new AuthenticationError('Edge 认证窗口提前关闭。', undefined)); }); });
        browser.once('error', cause => fail(new AuthenticationError('无法启动系统 Edge 认证窗口。', cause)));
        const endpoint = await debuggerEndpoint(debugPort, controller.signal, report);
        assertActive();
        connectionOperation = connectCdp(endpoint, controller.signal, fail);
        cdp = await connectionOperation;
        assertActive();
        const version = z.object({ userAgent: z.string().min(1) }).parse(await cdp.send('Browser.getVersion', {}, undefined));
        const target = z.object({ targetId: z.string() }).parse(await cdp.send('Target.createTarget', { url: 'about:blank' }, undefined));
        pageSession = z.object({ sessionId: z.string() }).parse(await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, undefined)).sessionId;
        adapter = {
          userAgent: version.userAgent,
          async getCookies() {
            const cookies = z.object({ cookies: z.array(browserCookieSchema) }).parse(await send('Network.getAllCookies', {})).cookies;
            return cookies.filter(cookie => {
              const domain = cookie.domain.replace(/^\./, '');
              return allowedAuthHosts.has(domain) || domain === 'swu.edu.cn';
            });
          },
          async setCookie(cookie: Cookie) {
            const expiration = cookie.expiryTime();
            if (!cookie.domain || expiration === undefined || Number.isNaN(expiration)) throw new AuthenticationError('学校会话 Cookie 范围或有效期无效。', undefined);
            const expires = expiration <= Date.now() ? 1 : Number.isFinite(expiration) ? expiration / 1000 : undefined;
            const sameSite = cookie.sameSite === 'none' ? 'None' : cookie.sameSite === 'strict' ? 'Strict' : cookie.sameSite === 'lax' ? 'Lax' : undefined;
            const result = z.object({ success: z.boolean() }).parse(await send('Network.setCookie', {
              url: `https://${cookie.domain}${cookie.path || '/'}`, name: cookie.key, value: cookie.value,
              ...(cookie.hostOnly ? {} : { domain: `.${cookie.domain}` }), path: cookie.path || '/',
              secure: cookie.secure, httpOnly: cookie.httpOnly,
              ...(expires !== undefined ? { expires } : {}), ...(sameSite ? { sameSite } : {}),
            }));
            if (!result.success) throw new AuthenticationError('Edge 无法接收学校会话 Cookie。', undefined);
          },
        };
        removeEvents = cdp.onEvent((method, params, eventSession) => {
          if (eventSession !== pageSession || finishing) return;
          if (method === 'Page.lifecycleEvent') {
            const parsed = lifecycleSchema.safeParse(params);
            if (parsed.success && parsed.data.name === 'load') { loadedDocuments.add(parsed.data.loaderId); documentLastChanged = Date.now(); }
          }
          if (method === 'Fetch.requestPaused') {
            const parsed = pausedSchema.safeParse(params);
            if (!parsed.success) { fail(new AuthenticationError('学校认证请求结构无效。', undefined)); return; }
            const request = parsed.data;
            let allowed = false;
            try {
              const url = checkedSchoolUrl(request.request.url);
              allowed = !(url.hostname === 'idm.swu.edu.cn' && request.request.method !== 'GET');
            } catch (cause) {
              if (request.resourceType === 'Document') fail(cause);
            }
            void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId: request.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }).catch(fail);
          }
          if (method === 'Network.responseReceived') {
            const parsed = responseSchema.safeParse(params);
            if (!parsed.success) return;
            const { requestId, response } = parsed.data;
            const url = new URL(response.url);
            if (parsed.data.type === 'Document') {
              documentLastChanged = Date.now();
              report({ level: 'info', event: 'auth-navigation', message: `学校认证页面 ${url.hostname}${url.pathname} 返回 HTTP ${response.status}。` });
              if (response.status >= 400) { fail(new AuthenticationError(`学校认证页面 ${url.hostname}${url.pathname} 返回 HTTP ${response.status}，请检查学校认证服务或网络后重新登录。`, undefined)); return; }
            }
            if (url.protocol !== 'https:' || url.hostname !== 'of.swu.edu.cn' || url.pathname.split('/').at(-1) !== 'exchange-token') return;
            if (response.status !== 200) { fail(new AuthenticationError(`学校应用令牌交换失败：HTTP ${response.status}。`, undefined)); return; }
            const header = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'fighter-auth-token');
            if (header) {
              const validated = tokenSchema.safeParse(header[1]);
              if (!validated.success) fail(new AuthenticationError('学校应用令牌响应头无效。', undefined));
              else token = validated.data;
            } else tokenRequests.add(requestId);
          }
          if (method === 'Network.loadingFinished') {
            const parsed = finishedSchema.safeParse(params);
            if (parsed.success) {
              if (tokenRequests.delete(parsed.data.requestId)) void collectBody(parsed.data.requestId).catch(fail);
            }
          }
        });
        await send('Network.enable', {});
        for (const cookie of savedCookies) {
          const domain = cookie.domain.replace(/^\./, '');
          if (!allowedAuthHosts.has(domain) && domain !== 'swu.edu.cn') throw new AuthenticationError('已保存的学校会话域名无效。', undefined);
          if (cookie.expires > 0 && cookie.expires * 1000 <= Date.now()) continue;
          const result = z.object({ success: z.boolean() }).parse(await send('Network.setCookie', {
            name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path,
            secure: cookie.secure, httpOnly: cookie.httpOnly,
            ...(cookie.expires > 0 ? { expires: cookie.expires } : {}),
            ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
          }));
          if (!result.success) throw new AuthenticationError('无法恢复已保存的学校登录会话。', undefined);
        }
        await send('Page.enable', {});
        await send('Page.setLifecycleEventsEnabled', { enabled: true });
        await send('Runtime.enable', {});
        await send('Fetch.enable', { patterns: [{ urlPattern: 'http*', requestStage: 'Request' }] });
        report({ level: 'info', event: 'auth-sso', message: '正在建立学校 SSO 会话。' });
        const destination = await progressSso();
        if (destination === 'application') {
          await until(async () => token !== null, controller.signal, 60_000, '学校未返回应用登录会话。');
          if (!token) throw new AuthenticationError('学校应用令牌为空。', undefined);
          await finish({ ok: true, token });
          return;
        }
        await until(async () => z.boolean().parse(await evaluate("document.readyState === 'complete' && Boolean(document.forms.namedItem('Login'))")), controller.signal, 20_000, '学校未返回完整登录表单。');
        const extracted = formSchema.safeParse(await evaluate(`(() => {
          const form = document.forms.namedItem('Login');
          if (!form) return null;
          const fields = {};
          for (const element of form.elements) if (element instanceof HTMLInputElement && element.type === 'hidden' && element.name) fields[element.name] = element.value;
          return { action: form.action, pageUrl: location.href, fields };
        })()`));
        if (!extracted.success || Object.keys(extracted.data.fields).length === 0) throw new AuthenticationError('学校登录表单隐藏字段缺失。', undefined);
        form = extracted.data;
        const action = checkedSchoolUrl(form.action);
        if (action.hostname !== 'idm.swu.edu.cn' || action.pathname !== '/am/UI/Login') throw new AuthenticationError('学校登录表单地址发生变化。', undefined);
        checkedSchoolUrl(form.pageUrl);
        await importBrowserCookies(adapter, jar);
        const selectedForm = form;
        const selectedAdapter = adapter;
        const captcha = await runHttp(() => fetchCaptcha(selectedForm, jar, selectedAdapter, controller.signal));
        assertActive();
        const captchaCode = await fillCaptcha(captcha);
        assertActive();
        update({ stage: 'ready', message: captchaCode ? '已自动识别验证码，可直接登录；识别有误时请修改或换一张。' : '请输入校园账号、密码和图片中的 4 位验证码。', captcha, captchaCode });
      } catch (cause) {
        const error = safeFailure(cause);
        await finish({ ok: false, error });
        throw error;
      }
    },
    async submit(payload) {
      const credentials = credentialsSchema.safeParse(payload);
      if (!credentials.success) throw new AuthenticationError('请填写校园账号、密码和 4 位数字验证码。', undefined);
      if (!form || !adapter || submitted || refreshing || finishing) throw new AuthenticationError('当前登录状态不允许提交。', undefined);
      submitted = true;
      update({ stage: 'submitting', message: '正在向学校提交认证…', captcha: '', captchaCode: '' });
      try {
        const selectedForm = form;
        const selectedAdapter = adapter;
        const page = await currentUrl();
        if (page?.hostname !== 'idm.swu.edu.cn' || page.pathname !== '/am/UI/Login') {
          throw new AuthenticationError('当前学校页面不再是 IDM 登录表单，未提交认证请求。', undefined);
        }
        // JSON encoding prevents credential strings from changing the evaluated JavaScript program.
        const rawPrepared = await evaluate(`(() => {
          const payload = ${JSON.stringify(credentials.data)};
          const key = document.getElementById('random');
          if (!(key instanceof HTMLInputElement) || !key.value || typeof strEnc !== 'function') return null;
          try {
            return {
              idToken1: strEnc(payload.username, key.value, '', ''),
              idToken2: strEnc(payload.password, key.value, '', ''),
              validateCode: payload.captcha,
            };
          } finally { payload.username = ''; payload.password = ''; payload.captcha = ''; }
        })()`);
        credentials.data.password = ''; credentials.data.username = ''; credentials.data.captcha = '';
        const prepared = preparedAuthenticationSchema.safeParse(rawPrepared);
        if (!prepared.success) throw new AuthenticationError('学校登录加密组件或随机密钥无效，未提交认证请求。', undefined);
        assertActive();
        await runHttp(() => submitAuthentication(selectedForm, prepared.data, jar, selectedAdapter, controller.signal));
        assertActive();
        credentials.data.password = ''; credentials.data.username = ''; credentials.data.captcha = '';
        update({ stage: 'submitting', message: '学校认证已通过，正在完成应用登录…', captcha: '', captchaCode: '' });
        report({ level: 'info', event: 'auth-accepted', message: '学校已通过认证，正在获取应用会话。' });
        await progressSso();
        await until(async () => token !== null, controller.signal, 60_000, '认证已通过，但学校未返回应用登录会话。');
        if (!token) throw new AuthenticationError('学校应用令牌为空。', undefined);
        await finish({ ok: true, token });
      } catch (cause) {
        const error = safeFailure(cause); await finish({ ok: false, error }); throw error;
      } finally { credentials.data.password = ''; credentials.data.username = ''; credentials.data.captcha = ''; }
    },
    async refresh() {
      if (!form || !adapter || submitted || refreshing || finishing) throw new AuthenticationError('当前登录状态不允许更新验证码。', undefined);
      refreshing = true;
      update({ stage: 'preparing', message: '正在更新验证码…', captcha: '', captchaCode: '' });
      const selectedForm = form;
      const selectedAdapter = adapter;
      try {
        const captcha = await runHttp(() => fetchCaptcha(selectedForm, jar, selectedAdapter, controller.signal));
        assertActive();
        const captchaCode = await fillCaptcha(captcha);
        assertActive();
        update({ stage: 'ready', message: captchaCode ? '已自动识别验证码，可直接登录；识别有误时请修改或换一张。' : '请输入校园账号、密码和图片中的 4 位验证码。', captcha, captchaCode });
      }
      catch (cause) { const error = safeFailure(cause); await finish({ ok: false, error }); throw error; }
      finally { refreshing = false; }
    },
    getCookies: () => sessionCookies.map(cookie => ({ ...cookie })),
    async cancel() { await finish({ ok: false, error: new AuthenticationError('登录已取消。', undefined) }); },
  };
}
