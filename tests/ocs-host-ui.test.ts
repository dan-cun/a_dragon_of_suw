import { expect, test } from 'bun:test';
import { expect as browserExpect } from '@playwright/test';
import { chromium, type Page } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { ocsCommandSchema, type OcsCommand, type OcsState } from '../desktop/shared/ocs';
import { OCS_UNSUPPORTED_LOGINS } from '../desktop/shared/ocs-login';
import { createOcsRepository } from '../desktop/bun/ocs-storage';

const instanceSchema = z.object({ pid: z.number().int().positive(), port: z.number().int().positive(), launchKey: z.string().min(1) });
const failureSchema = z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) });
async function state(page: Page): Promise<OcsState> {
  const result = await page.evaluate(() => window.ocs.execute({ command: 'state' }));
  if (!result.ok) throw new Error('Isolated OCS state failed: ' + result.error.message);
  return result.value;
}
async function idle(page: Page): Promise<void> {
  await browserExpect(page.getByTestId('ocs-page')).toHaveAttribute('aria-busy', 'false');
}
async function refresh(page: Page): Promise<void> {
  await page.getByTestId('ocs-refresh').click();
  await idle(page);
}

/** Exercise the actual source host, bridge and renderer with isolated authored data only. */
test('OCS source UI requires exact authorization and separate saved-name login consent without public credential submission', async () => {
  const evidence = process.env['SWU_OCS_UI_EVIDENCE'];
  const executablePath = process.env['SWU_OCS_BROWSER'];
  if (!evidence || !isAbsolute(evidence) || !executablePath || !isAbsolute(executablePath)) throw new Error('Explicit SWU_OCS_UI_EVIDENCE and SWU_OCS_BROWSER paths are required.');
  const distance = relative(resolve('work'), resolve(evidence));
  if (!distance || isAbsolute(distance) || distance === '..' || distance.startsWith('..' + sep)) throw new Error('UI evidence must use its own directory below project work.');
  const directory = join(evidence, 'isolated-user-data');
  await mkdir(directory);
  const stages: string[] = [];
  const errors: string[] = [];
  const commands: OcsCommand['command'][] = [];
  const recordedAuthorizations: { id: string; digest: string; authorized: boolean; confirmed: true }[] = [];
  const bundle = await Bun.build({ entrypoints: [resolve('desktop/renderer/index.html')], target: 'browser', outdir: join(evidence, 'TEST_ONLY-renderer'), minify: true });
  if (!bundle.success) throw new AggregateError(bundle.logs, 'TEST_ONLY renderer bundle failed.');
  stages.push('TEST_ONLY renderer bundle');
  const child = Bun.spawn([process.execPath, 'desktop/bun/launch.ts', '--no-window'], {
    cwd: process.cwd(), env: { ...process.env, SWU_USER_DATA_DIR: directory },
    stdout: Bun.file(join(evidence, 'host.stdout.log')), stderr: Bun.file(join(evidence, 'host.stderr.log'))
  });
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking', '--no-first-run'] });
  const context = await browser.newContext({ viewport: { width: 1240, height: 900 } });
  const page = await context.newPage();
  let origin: string | null = null;
  let launched = false;
  let passed = false;
  let failure: string | null = null;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/ocs' || request.method() !== 'POST') return;
    const command = ocsCommandSchema.safeParse(request.postDataJSON());
    if (!command.success) return;
    commands.push(command.data.command);
    if (command.data.command === 'script-config-sync') {
      const { id, digest, authorized, confirmed } = command.data;
      recordedAuthorizations.push({ id, digest, authorized, confirmed });
    }
  });
  try {
    let instance: z.infer<typeof instanceSchema> | null = null;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('The isolated source host exited before publishing its endpoint.');
      try { instance = instanceSchema.parse(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'))); break; }
      catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')) throw cause; }
      await Bun.sleep(100);
    }
    if (!instance) throw new Error('The isolated source host did not publish its endpoint within 30 seconds.');
    origin = `http://127.0.0.1:${instance.port}`;
    try { await page.goto(`${origin}/launch/${instance.launchKey}`); }
    catch (cause) { throw new Error('Isolated launch navigation failed: ' + (cause instanceof Error ? cause.message.replaceAll(instance.launchKey, '[redacted]') : 'Non-Error rejection')); }
    launched = true;
    await page.getByTestId('nav-ocs').click();
    await page.getByTestId('ocs-browser-empty').waitFor();
    await page.getByTestId('ocs-browser-new').click();
    await page.getByTestId('ocs-browser-name').fill('Authored UI blank profile');
    await page.getByTestId('ocs-browser-create').click();
    await idle(page);
    const firstBrowser = (await state(page)).browsers[0];
    if (!firstBrowser) throw new Error('The UI did not create isolated browser metadata.');
    await page.getByTestId('ocs-tab-scripts').click();
    const content = ['// ==UserScript==', '// @name Authored UI GM reader', '// @include about:blank', '// @grant GM_getValue', '// ==/UserScript==', 'void 0;'].join('\n');
    await page.getByTestId('ocs-script-file').setInputFiles({ name: 'authored-ui.user.js', mimeType: 'text/javascript', buffer: Buffer.from(content) });
    await page.getByTestId('ocs-script-empty').waitFor({ state: 'hidden' });
    const script = (await state(page)).userScripts[0];
    if (!script) throw new Error('The UI did not import the isolated script.');
    await browserExpect(page.getByTestId(`ocs-script-digest-${script.id}`)).toContainText(script.digest);
    expect(script.configSyncAuthorized).toBe(false);
    const repository = createOcsRepository(directory);
    const encryptedPath = join(repository.root, 'configuration.dpapi.json');
    const beforeConsent = await readFile(encryptedPath);
    const missingConfirmation = await context.request.post(`${origin}/api/ocs`, { headers: { Origin: origin, 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, data: { command: 'script-config-sync', id: script.id, digest: script.digest, authorized: true } });
    failureSchema.parse(await missingConfirmation.json());
    expect((await readFile(encryptedPath)).equals(beforeConsent)).toBe(true);
    await page.getByTestId(`ocs-script-config-sync-${script.id}`).click();
    await browserExpect(page.getByTestId('ocs-confirm-dialog')).toContainText(script.digest);
    await browserExpect(page.getByTestId('ocs-confirm-dialog')).toContainText('题库凭据');
    await browserExpect(page.getByTestId('ocs-confirm-dialog')).toContainText('无法召回');
    await page.getByTestId('ocs-confirm-cancel').click();
    expect((await readFile(encryptedPath)).equals(beforeConsent)).toBe(true);
    expect(recordedAuthorizations).toHaveLength(0);
    await page.getByTestId(`ocs-script-config-sync-${script.id}`).click();
    await page.getByTestId('ocs-confirm-submit').click();
    await browserExpect(page.getByTestId(`ocs-script-sync-status-${script.id}`)).toContainText('已授权此精确源码版本');
    expect(recordedAuthorizations).toEqual([{ id: script.id, digest: script.digest, authorized: true, confirmed: true }]);
    expect((await state(page)).settings.syncEnabled).toBe(false);
    await page.getByTestId(`ocs-script-config-sync-${script.id}`).click();
    await page.getByTestId('ocs-confirm-submit').click();
    await browserExpect(page.getByTestId(`ocs-script-sync-status-${script.id}`)).toContainText('尚未授权私有配置');
    expect(recordedAuthorizations[1]).toEqual({ id: script.id, digest: script.digest, authorized: false, confirmed: true });
    stages.push('Exact digest authorization, cancellation, missing consent and revocation through real host');
    await page.getByTestId('ocs-tab-settings').click();
    const privateMarker = 'authored-private-wrapper-' + randomUUID();
    const configState = await state(page);
    const privateSaved = await page.evaluate(({ settings, value }) => window.ocs.execute({ command: 'settings-save', settings: { ...settings, globalConfigJson: JSON.stringify({
      'common.settings.thread': 2,
      'common.settings.answererWrappers': [{ name: 'Authored private UI wrapper', url: 'https://example.invalid/query?access=' + value, headers: { 'X-Custom': value }, data: { opaque: value } }]
    }) } }), { settings: configState.settings, value: privateMarker });
    if (!privateSaved.ok) throw new Error('Isolated private wrapper save failed: ' + privateSaved.error.message);
    expect(JSON.stringify(privateSaved.value).includes(privateMarker)).toBe(false);
    await refresh(page);
    expect((await page.getByTestId('ocs-settings-json').inputValue()).includes(privateMarker)).toBe(false);
    expect((await page.content()).includes(privateMarker)).toBe(false);
    stages.push('Private wrapper URL, arbitrary header and data markers absent from actual DTO and advanced JSON DOM');
    await page.getByTestId('ocs-settings-sync').check();
    await page.getByTestId('ocs-settings-save').click();
    await page.getByTestId('ocs-settings-saved').waitFor();
    expect((await state(page)).userScripts[0]?.configSyncAuthorized).toBe(false);
    await browserExpect(page.getByTestId('ocs-settings-saved')).toContainText('下次浏览器启动前');
    await page.getByTestId('ocs-tab-browsers').click();
    await page.getByTestId(`ocs-browser-select-${firstBrowser.id}`).click();
    await browserExpect(page.getByTestId('ocs-automation-run')).toBeDisabled();
    await page.getByTestId('ocs-automation-name').selectOption('超星-手机密码登录');
    const marker = 'authored-ui-' + randomUUID();
    await page.getByTestId('ocs-automation-field-phone').fill('authored-no-account');
    await page.getByTestId('ocs-automation-field-password').fill(marker);
    await page.getByTestId('ocs-automation-save').click();
    await page.getByTestId('ocs-automation-saved').waitFor();
    expect(await page.getByTestId('ocs-automation-field-password').inputValue()).toBe('');
    expect((await readFile(encryptedPath)).includes(Buffer.from(marker))).toBe(false);
    expect(JSON.stringify(await state(page)).includes(marker)).toBe(false);
    await page.getByTestId(`ocs-browser-start-${firstBrowser.id}`).click();
    await browserExpect(page.getByTestId(`ocs-browser-phase-${firstBrowser.id}`)).toHaveText('运行中');
    expect(commands.filter(command => command === 'automation-run')).toHaveLength(0);
    await browserExpect(page.getByTestId('ocs-automation-run')).toBeEnabled();
    await page.getByTestId('ocs-automation-run').click();
    await browserExpect(page.getByTestId('ocs-confirm-dialog')).toContainText('已保存');
    await browserExpect(page.getByTestId('ocs-confirm-dialog')).toContainText('最多一次提交');
    await browserExpect(page.getByTestId('ocs-confirm-dialog')).toContainText('收费');
    await page.getByTestId('ocs-confirm-cancel').click();
    expect(commands.filter(command => command === 'automation-run')).toHaveLength(0);
    await page.getByTestId('ocs-automation-field-password').fill('unsaved-authored-marker');
    await browserExpect(page.getByTestId('ocs-automation-run')).toBeDisabled();
    await browserExpect(page.getByTestId('ocs-automation-run-reason')).toContainText('未保存');
    await page.getByTestId('ocs-automation-name').selectOption('智慧职教-账号密码登录');
    await browserExpect(page.getByTestId('ocs-automation-run')).toBeDisabled();
    await browserExpect(page.getByTestId('ocs-automation-run-reason')).toContainText('不一致');
    await page.getByTestId('ocs-automation-name').selectOption('超星-手机密码登录');
    await page.getByTestId('ocs-automation-clear').click();
    await page.getByTestId('ocs-confirm-submit').click();
    await idle(page);
    stages.push('Saved secrets withheld; save/start/cancel never execute; draft/name gates');
    await page.getByTestId('ocs-tab-scripts').click();
    await browserExpect(page.getByTestId(`ocs-script-config-sync-${script.id}`)).toBeDisabled();
    await browserExpect(page.getByTestId(`ocs-script-enable-${script.id}`)).toBeDisabled();
    await browserExpect(page.getByTestId(`ocs-script-delete-${script.id}`)).toBeDisabled();
    await browserExpect(page.getByTestId('ocs-resource-locked')).toContainText('停止全部');
    stages.push('Owned browser disables script authorization/enable/delete');
    await page.getByTestId('ocs-tab-browsers').click();
    for (const [name, reason] of Object.entries(OCS_UNSUPPORTED_LOGINS)) {
      await page.getByTestId('ocs-automation-name').selectOption(name);
      await browserExpect(page.getByTestId('ocs-automation-run')).toBeDisabled();
      await browserExpect(page.getByTestId('ocs-automation-support')).toContainText(reason);
    }
    await page.getByTestId('ocs-automation-name').selectOption('通用-新建页面');
    await browserExpect(page.getByTestId('ocs-automation-run')).toBeDisabled();
    await browserExpect(page.getByTestId('ocs-automation-support')).toContainText('不属于登录操作');
    expect(commands.filter(command => command === 'automation-run')).toHaveLength(0);
    stages.push('Shared unsupported policies and navigation disable login without any automation-run');
    await page.getByTestId('ocs-automation-name').selectOption('智慧树-手机密码登录');
    await page.getByTestId('ocs-automation-save').click();
    await page.getByTestId('ocs-automation-saved').waitFor();
    const savedUnsupported = (await repository.read()).automations.find(item => item.browserId === firstBrowser.id);
    if (!savedUnsupported || savedUnsupported.values.some(value => value.value !== '')) throw new Error('Unsupported-only result check must have no credential values.');
    await browserExpect(page.getByTestId('ocs-automation-run')).toBeDisabled();
    expect(commands.filter(command => command === 'automation-run')).toHaveLength(0);
    const unsupportedResult = await page.evaluate(id => window.ocs.execute({ command: 'automation-run', id, name: '智慧树-手机密码登录', confirmed: true }), firstBrowser.id);
    if (!unsupportedResult.ok) throw new Error('The real empty-parameter unsupported diagnostic failed: ' + unsupportedResult.error.message);
    expect(unsupportedResult.value.automationRun?.result.status).toBe('unsupported');
    await refresh(page);
    await browserExpect(page.getByTestId('ocs-automation-result')).toHaveAttribute('data-status', 'unsupported');
    await browserExpect(page.getByTestId('ocs-automation-result-status')).toContainText('尚未提交');
    await browserExpect(page.getByTestId('ocs-automation-result-name')).toContainText('智慧树-手机密码登录');
    expect(await page.getByTestId('ocs-automation-result').locator('.ocs-success,.ocs-success-text').count()).toBe(0);
    const actualResult = (await state(page)).automationRun;
    expect(actualResult?.result.status).toBe('unsupported');
    expect(actualResult?.result.submitAttempts).toBe(0);
    expect(actualResult?.result.loginVerified).toBe(false);
    const secondCreated = await page.evaluate(() => window.ocs.execute({ command: 'browser-create', browser: { name: 'Other isolated UI profile', folder: '', notes: '', tags: [], startUrl: 'about:blank' } }));
    if (!secondCreated.ok) throw new Error(secondCreated.error.message);
    const second = secondCreated.value.browsers.find(item => item.id !== firstBrowser.id);
    if (!second) throw new Error('The independent second browser was not created.');
    await refresh(page);
    await page.getByTestId(`ocs-browser-select-${second.id}`).click();
    await page.getByTestId('ocs-automation-result-empty').waitFor();
    expect(await page.getByTestId('ocs-automation-result').count()).toBe(0);
    await page.getByTestId(`ocs-browser-select-${firstBrowser.id}`).click();
    await page.getByTestId('ocs-automation-result').waitFor();
    await page.setViewportSize({ width: 760, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(evidence, 'ocs-result-narrow.png'), fullPage: true });
    stages.push('Real unsupported result has zero submissions, neutral DOM and selected-browser isolation; 760px layout');
    expect(commands.filter(command => command === 'automation-run')).toHaveLength(1);
    expect(errors).toEqual([]);
    await page.getByTestId('ocs-tab-settings').click();
    await browserExpect(page.getByTestId('ocs-settings-sync')).toBeDisabled();
    await page.getByTestId('ocs-settings-locked').waitFor();
    stages.push('Owned browser disables settings via parent integration');
    passed = true;
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : 'Non-Error test failure';
    throw cause;
  } finally {
    try {
      if (launched && origin !== null && child.exitCode === null) {
        const result = await context.request.post(`${origin}/api/quit`, { headers: { Origin: origin, 'Content-Type': 'application/json', 'X-SWU-Request': '1' }, data: {} });
        const reply = z.object({ ok: z.literal(true) }).safeParse(await result.json());
        if (!reply.success) throw new Error('The isolated source host refused normal shutdown.');
        const exit = await Promise.race([child.exited, Bun.sleep(15000).then(() => { throw new Error('The isolated source host did not exit normally within 15 seconds; no forced termination attempted.'); })]);
        if (exit !== 0) throw new Error('The isolated source host exited with code ' + String(exit));
      } else if (child.exitCode === null) throw new Error('Isolated host startup did not reach an authenticated endpoint; no forced termination attempted.');
    } finally {
      await browser.close();
      await Bun.write(join(evidence, 'ui-result.json'), JSON.stringify({ at: new Date().toISOString(), passed, failure, stages, sourceUi: true, realHost: true, realDpapi: true, realChrome: true, backendMocked: false, recordedAuthorizations, observedCommands: commands, pageErrors: errors, supportedLoginCommands: 0, unsupportedEmptyParameterCommands: commands.filter(command => command === 'automation-run').length, realAccountsUsed: false, publicFormsAccessed: false, modelCalls: 0, formalBuild: false, awaitingOrSubmittedStatusLiveTested: false }, null, 2));
    }
  }
}, 150000);
