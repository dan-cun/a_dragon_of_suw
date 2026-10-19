import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { runOcsAutomation } from '../desktop/bun/ocs-automation';
import {
  OCS_PHONE_AUTOMATION, OCS_PHONE_LOGIN_URL, assertOcsAutomationSupported,
  assertOcsAutomationTarget, ocsAutomationResultSchema, parseOcsAutomationValues, redactOcsAutomationCause
} from '../desktop/ocs/automation-policy';

const values = [{ key: 'phone', value: 'policy-phone-only' }, { key: 'password', value: 'policy-password-only' }];
const confirmed = { confirmed: true };
const integration = process.env['SWU_OCS_AUTOMATION_TEST'] === '1' ? test : test.skip;

test('OCS automation policy requires fresh explicit confirmation and exact required fields', () => {
  expect(() => parseOcsAutomationValues(OCS_PHONE_AUTOMATION, values, { confirmed: false })).toThrow('confirmed:true');
  expect(() => parseOcsAutomationValues(OCS_PHONE_AUTOMATION, [], confirmed)).toThrow('phone 与 password');
  expect(() => parseOcsAutomationValues(OCS_PHONE_AUTOMATION, values.slice(0, 1), confirmed)).toThrow('phone 与 password');
  expect(() => parseOcsAutomationValues(OCS_PHONE_AUTOMATION, [...values, values[0]!], confirmed)).toThrow('各提供一次');
  for (const value of ['', '   ', 'x'.repeat(2001)]) {
    expect(() => parseOcsAutomationValues(OCS_PHONE_AUTOMATION, [{ key: 'phone', value }, values[1]!], confirmed)).toThrow(TypeError);
    expect(() => parseOcsAutomationValues(OCS_PHONE_AUTOMATION, [values[0]!, { key: 'password', value }], confirmed)).toThrow(TypeError);
  }
  const before = JSON.stringify(values);
  expect(parseOcsAutomationValues(OCS_PHONE_AUTOMATION, [...values, { key: 'unrelated', value: 'ignored' }], confirmed)).toEqual({ phone: 'policy-phone-only', password: 'policy-password-only' });
  expect(parseOcsAutomationValues(OCS_PHONE_AUTOMATION, [values[0]!, { key: 'password', value: ' keep spaces ' }], confirmed).password).toBe(' keep spaces ');
  expect(JSON.stringify(values)).toBe(before);
});

test('OCS automation refuses catalog entries without a verified stable-ID implementation', () => {
  for (const name of ['超星-学校机构登录', '智慧树-手机密码登录', '智慧树-学校登录', '职教云-账号密码登录', '智慧职教-账号密码登录', '通用-新建页面', 'unknown']) {
    expect(() => assertOcsAutomationSupported(name)).toThrow(RangeError);
    expect(() => parseOcsAutomationValues(name, values, confirmed)).toThrow(RangeError);
  }
  expect(() => assertOcsAutomationSupported(OCS_PHONE_AUTOMATION)).not.toThrow();
});

test('OCS automation target policy pins HTTPS origin, exact path and unparameterized login', () => {
  expect(() => assertOcsAutomationTarget(OCS_PHONE_LOGIN_URL)).not.toThrow();
  for (const url of [
    'about:blank', 'not a URL', 'http://passport2.chaoxing.com/login', 'https://passport2.chaoxing.com.evil.invalid/login',
    'https://passport2.chaoxing.com:8443/login', 'https://passport2.chaoxing.com/login/', 'https://passport2.chaoxing.com/login/other',
    'https://passport2.chaoxing.com/login?', 'https://passport2.chaoxing.com/login#',
    'https://passport2.chaoxing.com/space/index', 'https://passport2.chaoxing.com/login?refer=https://example.invalid/',
    'https://passport2.chaoxing.com/login#fragment', 'https://user:secret@passport2.chaoxing.com/login',
    'https://passport.zhihuishu.com/login', 'https://sso.icve.com.cn/sso/auth', 'https://zjy2.icve.com.cn/portal/login.html'
  ]) {
    expect(() => assertOcsAutomationTarget(url)).toThrow(DOMException);
  }
});

test('OCS automation result schema cannot describe login success or leak extra fields', () => {
  const submitted = { name: OCS_PHONE_AUTOMATION, stage: 'submitted', submitAttempts: 1, reason: 'platform-result-unverified', loginVerified: false, requiresManualVerification: true };
  expect(ocsAutomationResultSchema.safeParse(submitted).success).toBe(true);
  expect(ocsAutomationResultSchema.safeParse({ ...submitted, loginVerified: true }).success).toBe(false);
  expect(ocsAutomationResultSchema.safeParse({ ...submitted, password: 'must-not-return' }).success).toBe(false);
  expect(ocsAutomationResultSchema.safeParse({ ...submitted, submitAttempts: 2 }).success).toBe(false);
  expect(ocsAutomationResultSchema.safeParse({ ...submitted, stage: 'awaiting-verification', submitAttempts: 0, reason: 'captcha' }).success).toBe(true);
});

test('OCS automation preserves causal diagnostics without private values or URL material', () => {
  const credentials = { phone: 'private phone', password: 'private password' };
  const original = new Error('private password at https://example.invalid/login?token=secret', { cause: new TypeError('private phone; private%20password') });
  const sanitized = redactOcsAutomationCause(original, credentials, new Set<Error>());
  expect(sanitized).not.toBe(original);
  expect(sanitized.message).toContain('[redacted]');
  expect(sanitized.cause).toBeInstanceOf(Error);
  expect((sanitized.cause as Error).name).toBe('TypeError');
  for (const text of [sanitized.message, sanitized.stack ?? '', (sanitized.cause as Error).message]) {
    expect(text).not.toContain(credentials.phone);
    expect(text).not.toContain(credentials.password);
    expect(text).not.toContain('token=secret');
  }
  expect(original.message).toContain(credentials.password);
});

test('OCS automation cause redaction handles escaped input, malformed Unicode and causal cycles', () => {
  const credentials = { phone: 'line\nvalue', password: String.fromCharCode(0xd800) };
  const original = new AggregateError([new URIError(JSON.stringify(credentials.phone)), new Error(credentials.password)], 'Page execution rejected');
  original.cause = original;
  const sanitized = redactOcsAutomationCause(original, credentials, new Set<Error>());
  expect(sanitized).toBeInstanceOf(AggregateError);
  const children = sanitized instanceof AggregateError ? sanitized.errors as unknown[] : [];
  expect(children).toHaveLength(2);
  expect(children.every(child => child instanceof Error)).toBe(true);
  for (const child of children) {
    if (!(child instanceof Error)) throw new TypeError('Sanitized aggregate children must be Error instances.');
    expect(child.message).not.toContain(credentials.phone);
    expect(child.message).not.toContain(JSON.stringify(credentials.phone).slice(1, -1));
    expect(child.message).not.toContain(credentials.password);
  }
  expect(sanitized.cause).toBeInstanceOf(Error);
  expect(original.cause).toBe(original);
});

integration('OCS automation real Chrome: origin/parameter refusal and read-only public selector verification', async () => {
  const executable = process.env['SWU_OCS_BROWSER'];
  if (!executable || !isAbsolute(executable) || !(await lstat(executable)).isFile()) throw new Error('SWU_OCS_BROWSER must explicitly name the verified standalone Chrome executable.');
  const work = await mkdtemp(join(resolve(import.meta.dir, '../work'), 'ocs-automation-'));
  console.log(JSON.stringify({ event: 'ocs.automation.evidence', work }));
  const sources = ['desktop/bun/ocs-automation.ts', 'desktop/ocs/automation-policy.ts', 'tests/ocs-automation.test.ts'];
  const fingerprints = Object.fromEntries(await Promise.all(sources.map(async path => [path, createHash('sha256').update(await readFile(resolve(import.meta.dir, '..', path))).digest('hex')] as const)));
  const context = await chromium.launchPersistentContext(join(work, 'chrome-profile'), {
    executablePath: executable, headless: true, viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: false,
    timeout: 30000, args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check']
  });
  const requests: { method: string; origin: string; path: string }[] = [];
  context.on('request', request => {
    const url = new URL(request.url());
    requests.push({ method: request.method(), origin: url.origin, path: url.pathname });
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('Local origin rejection probe; not a platform login fixture.') });
  let passed = false;
  let liveStatus: number | null = null;
  let selectors: { id: string; count: number; tag: string | null; type: string | null }[] = [];
  try {
    const page = context.pages()[0];
    if (!page) throw new Error('The isolated Chrome context has no page.');
    await expect(runOcsAutomation(page, OCS_PHONE_AUTOMATION, values, confirmed)).rejects.toMatchObject({ name: 'SecurityError' });
    await expect(runOcsAutomation(page, OCS_PHONE_AUTOMATION, values, { confirmed: false })).rejects.toThrow('confirmed:true');
    expect(requests).toHaveLength(0);
    await page.goto(server.url.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await expect(runOcsAutomation(page, OCS_PHONE_AUTOMATION, values, confirmed)).rejects.toMatchObject({ name: 'SecurityError' });
    expect(requests.every(request => request.method === 'GET')).toBe(true);
    const response = await page.goto(OCS_PHONE_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
    liveStatus = response?.status() ?? null;
    expect(liveStatus).toBe(200);
    expect(page.url()).toBe(OCS_PHONE_LOGIN_URL);
    selectors = await page.evaluate(() => ['phone', 'pwd', 'loginBtn'].map(id => {
      const element = document.getElementById(id);
      return { id, count: document.querySelectorAll(`#${id}`).length, tag: element?.tagName ?? null, type: element instanceof HTMLInputElement || element instanceof HTMLButtonElement ? element.type : null };
    }));
    expect(selectors).toEqual([{ id: 'phone', count: 1, tag: 'INPUT', type: 'text' }, { id: 'pwd', count: 1, tag: 'INPUT', type: 'password' }, { id: 'loginBtn', count: 1, tag: 'BUTTON', type: 'button' }]);
    const publicRequestCount = requests.length;
    await expect(runOcsAutomation(page, OCS_PHONE_AUTOMATION, values, { confirmed: false })).rejects.toThrow('confirmed:true');
    await expect(runOcsAutomation(page, OCS_PHONE_AUTOMATION, [], confirmed)).rejects.toThrow('phone 与 password');
    await expect(runOcsAutomation(page, '智慧树-手机密码登录', values, confirmed)).rejects.toThrow(RangeError);
    expect(await page.locator('#phone').inputValue()).toBe('');
    expect(await page.locator('#pwd').inputValue()).toBe('');
    expect(requests.length).toBeGreaterThanOrEqual(publicRequestCount);
    expect(requests.filter(request => !['GET', 'HEAD'].includes(request.method))).toEqual([]);
    await page.close();
    await expect(runOcsAutomation(page, OCS_PHONE_AUTOMATION, values, confirmed)).rejects.toMatchObject({ name: 'InvalidStateError' });
    passed = true;
  } finally {
    try { await context.close(); }
    finally {
      await server.stop(true);
      await writeFile(join(work, 'result.json'), JSON.stringify({
        at: new Date().toISOString(), passed, fingerprints, realChrome: true, publicPageReadOnly: true, liveStatus, selectors,
        nonReadRequests: requests.filter(request => !['GET', 'HEAD'].includes(request.method)),
        officialAccountDataRead: false, passwordFilled: false, loginSubmitted: false, loginVerified: false,
        courseExecutionTested: false, compiledDesktopTested: false, upstreamPagesForged: false
      }, null, 2), 'utf8');
    }
  }
}, 45000);
